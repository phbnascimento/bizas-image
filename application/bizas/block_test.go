package bizas

import (
	"bufio"
	"bytes"
	"encoding/hex"
	"flag"
	"fmt"
	"os"
	"strings"
	"testing"
)

// testdata/vector.txt é o vetor de teste compartilhado com o JS (application/server/bizas.test.js): seed fixa, campos
// fixos e Ed25519 determinístico, então os dois lados têm de produzir os mesmos bytes e assinaturas. Para regravar
// depois de uma mudança intencional de formato: go test ./bizas -run TestVector -update
var update = flag.Bool("update", false, "rewrite testdata/vector.txt")

const vectorPath = "testdata/vector.txt"

var vectorKeys = []string{"size", "pub", "genesis", "block1", "verify", "clz", "fingerprint", "poll", "vote", "case"}

func loadVector(t *testing.T) map[string]string {
	t.Helper()
	f, err := os.Open(vectorPath)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	v := map[string]string{}
	sc := bufio.NewScanner(f)
	sc.Buffer(nil, 1<<16)
	for sc.Scan() {
		k, val, ok := strings.Cut(sc.Text(), "=")
		if ok {
			v[k] = val
		}
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	for _, k := range vectorKeys {
		if _, ok := v[k]; !ok {
			t.Fatalf("test vector is missing key %q", k)
		}
	}
	return v
}

func testKey(t *testing.T) PrivateKey {
	t.Helper()
	seed := make([]byte, 32)
	for i := range seed {
		seed[i] = byte(i)
	}
	key, err := GetPrivKey(seed)
	if err != nil {
		t.Fatal(err)
	}
	return key
}

// Texto com caractere de vários bytes em UTF-8, para o limite em bytes ser exercitado
const testText = "Hello, Bizas! ✓"

// testWorkBits é o N do gênese do vetor: pequeno para o teste ser rápido, grande o bastante para a mineração precisar
// de várias tentativas (o JS tem de chegar ao mesmo nonce)
const testWorkBits = 8

// testChain monta a cadeia do vetor; bizas.test.js monta a mesma. Os dois blocos são minerados a partir do nonce
// inicial, de um em um, até a assinatura começar com testWorkBits bits zero
func testChain(t *testing.T) []Block {
	t.Helper()
	key := testKey(t)

	var genesis Block
	genesis.Room = DefaultRoomName
	genesis.Stamp = 1_763_490_000_123_456_789
	genesis.Nonce = 0x0102030405060708
	genesis.Info = testWorkBits
	if err := genesis.UploadString("genesis"); err != nil {
		t.Fatal(err)
	}
	genesis.Mine(key, testWorkBits)

	b := NextBlock([]Block{genesis})
	b.Stamp = 1_763_490_001_000_000_000
	b.Nonce = 42
	b.Info = 7
	if err := b.UploadString(testText); err != nil {
		t.Fatal(err)
	}
	b.Mine(key, testWorkBits)
	return []Block{genesis, b}
}

// vectorFor calcula, a partir do código atual, o conteúdo que testdata/vector.txt deve ter
func vectorFor(t *testing.T) string {
	chain := testChain(t)
	verr, idx := ChainVerify(chain)
	var sb strings.Builder
	fmt.Fprintf(&sb, "size=%d\n", len(chain[0].MarshalBinary()))
	fmt.Fprintf(&sb, "pub=%s\n", hex.EncodeToString(chain[1].Author[:]))
	fmt.Fprintf(&sb, "genesis=%s\n", hex.EncodeToString(chain[0].MarshalBinary()))
	fmt.Fprintf(&sb, "block1=%s\n", hex.EncodeToString(chain[1].MarshalBinary()))
	fmt.Fprintf(&sb, "verify=%v,%d\n", verr, idx)
	fmt.Fprintf(&sb, "nonces=%d,%d\n", chain[0].Nonce, chain[1].Nonce)
	fmt.Fprintf(&sb, "clz=%d\n", CountLeadingZeroBits([]byte{0, 0, 0x10, 0xff}))
	fp, err := Fingerprint(chain, len(chain))
	if err != nil {
		t.Fatal(err)
	}
	fmt.Fprintf(&sb, "fingerprint=%s\n", fp)

	// Enquetes: a cadeia do vetor segue com uma enquete exclusiva (bloco 2) e um voto na opção 1 (bloco 3), e cada caso
	// é um bloco no índice dado, conferido contra a cadeia até ali, com o código que o Go devolve
	polls := pollChain(t)
	verr, idx = ChainVerify(polls)
	fmt.Fprintf(&sb, "poll=%s\n", hex.EncodeToString(polls[2].MarshalBinary()))
	fmt.Fprintf(&sb, "vote=%s\n", hex.EncodeToString(polls[3].MarshalBinary()))
	fmt.Fprintf(&sb, "pollverify=%v,%d\n", verr, idx)
	fmt.Fprintf(&sb, "counts=%s\n", strings.Trim(fmt.Sprint(tallyOf(polls).Counts(2)), "[]"))
	for _, c := range pollCases(t, polls) {
		tally := tallyOf(polls[:c.index])
		got := tally.Check(c.index, &c.block)
		if got != c.want {
			t.Errorf("poll case %s: Check = %v, want %v", c.name, got, c.want)
		}
		fmt.Fprintf(&sb, "case=%s,%d,%v,%s\n", c.name, c.index, got, hex.EncodeToString(c.block.MarshalBinary()))
	}
	return sb.String()
}

const testPollQuestion = "Where shall we eat?"

var testPollOptions = []string{"Pizza", "Sushi", "<b>Tacos</b>"}

// pollChain é a cadeia do vetor com mais dois blocos minerados: a enquete exclusiva e o voto do mesmo autor na opção 1
func pollChain(t *testing.T) []Block {
	t.Helper()
	key := testKey(t)
	chain := testChain(t)
	p := NextBlock(chain)
	p.Stamp = 1_763_490_002_000_000_000
	p.Nonce = 1000
	if err := p.UploadPoll(testPollQuestion, testPollOptions, true); err != nil {
		t.Fatal(err)
	}
	p.Mine(key, testWorkBits)
	chain = append(chain, p)
	v := NextBlock(chain)
	v.Stamp = 1_763_490_003_000_000_000
	v.Nonce = 2000
	v.UploadVote(2, 1, true)
	v.Mine(key, testWorkBits)
	return append(chain, v)
}

func tallyOf(chain []Block) *Tally {
	tally := NewTally()
	for i := range chain {
		tally.Apply(i, &chain[i])
	}
	return tally
}

type pollCase struct {
	name  string
	index int
	want  ValidationError
	block Block
}

// pollCases são os casos de aceite e recusa das enquetes que o JS também confere. Os blocos são assinados (sem
// mineração): o Check não olha a assinatura, só o conteúdo e o estado
func pollCases(t *testing.T, chain []Block) []pollCase {
	t.Helper()
	key := testKey(t)
	other, err := GetPrivKey(bytes.Repeat([]byte{9}, 32))
	if err != nil {
		t.Fatal(err)
	}
	next := func(typ DataType, info uint32, data []byte, k PrivateKey) Block {
		b := NextBlock(chain)
		b.Stamp = 1_763_490_004_000_000_000
		if err := b.UploadBytes(data, typ); err != nil {
			t.Fatal(err)
		}
		b.Info = info
		b.Sign(k)
		return b
	}
	poll := func(parts ...string) []byte { return []byte(strings.Join(parts, "\x00")) }
	eleven := []string{"Q"}
	for i := range 11 {
		eleven = append(eleven, fmt.Sprintf("o%d", i))
	}
	genesis := next(Poll, 0, poll("Q", "A", "B"), key)
	genesis.Prev = Signature{}
	n := len(chain)
	return []pollCase{
		{"poll_ok_several", n, None, next(Poll, 0, poll("Q", "A", "B"), key)},
		{"poll_ten_options", n, None, next(Poll, 0, poll(eleven[:11]...), key)},
		{"poll_eleven_options", n, InvalidPoll, next(Poll, 0, poll(eleven...), key)},
		{"poll_one_option", n, InvalidPoll, next(Poll, 0, poll("Q", "A"), key)},
		{"poll_trailing_separator", n, InvalidPoll, next(Poll, 0, append(poll("Q", "A", "B"), 0), key)},
		{"poll_empty_question", n, InvalidPoll, next(Poll, 0, poll("", "A", "B"), key)},
		{"poll_empty_option", n, InvalidPoll, next(Poll, 0, poll("Q", "A", "", "B"), key)},
		{"poll_duplicate_option", n, InvalidPoll, next(Poll, 0, poll("Q", "A", "A"), key)},
		{"poll_option_equal_to_question", n, None, next(Poll, 0, poll("A", "A", "B"), key)},
		{"poll_invalid_utf8", n, InvalidPoll, next(Poll, 0, append(poll("Q", "A", "B"), 0xff), key)},
		{"poll_unknown_flag", n, InvalidPoll, next(Poll, 2, poll("Q", "A", "B"), key)},
		{"poll_genesis", 0, InvalidPoll, genesis},
		{"vote_other_author", n, None, next(Vote, 2, []byte{0, VoteCast}, other)},
		{"vote_revoke", n, None, next(Vote, 2, []byte{1, VoteRevoke}, key)},
		{"vote_same_option_again", n, DuplicateVote, next(Vote, 2, []byte{1, VoteCast}, key)},
		{"vote_exclusive_second_option", n, DuplicateVote, next(Vote, 2, []byte{0, VoteCast}, key)},
		{"vote_revoke_without_vote", n, InvalidVote, next(Vote, 2, []byte{0, VoteRevoke}, key)},
		{"vote_option_out_of_range", n, InvalidVote, next(Vote, 2, []byte{3, VoteCast}, other)},
		{"vote_bad_action", n, InvalidVote, next(Vote, 2, []byte{0, 2}, other)},
		{"vote_length_3", n, InvalidVote, next(Vote, 2, []byte{0, VoteCast, 0}, other)},
		{"vote_length_1", n, InvalidVote, next(Vote, 2, []byte{0}, other)},
		{"vote_not_a_poll", n, InvalidVote, next(Vote, 1, []byte{0, VoteCast}, other)},
		{"vote_missing_block", n, InvalidVote, next(Vote, 99, []byte{0, VoteCast}, other)},
		{"vote_on_itself", n, InvalidVote, next(Vote, uint32(n), []byte{0, VoteCast}, other)},
	}
}

func TestVector(t *testing.T) {
	want := vectorFor(t)
	if *update {
		if err := os.WriteFile(vectorPath, []byte(want), 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("rewrote %s", vectorPath)
		return
	}
	got, err := os.ReadFile(vectorPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != want {
		t.Fatalf("%s does not match the current code:\n--- file\n%s--- code\n%s", vectorPath, got, want)
	}
	v := loadVector(t)
	if v["size"] != "512" || v["verify"] != "NONE,-1" || v["clz"] != "19" {
		t.Fatalf("unexpected vector values: size=%s verify=%s clz=%s", v["size"], v["verify"], v["clz"])
	}
}

func TestBlockSize(t *testing.T) {
	var b Block
	if n := len(b.MarshalBinary()); n != BlockSize {
		t.Fatalf("block has %d bytes", n)
	}
}

// Blocos lidos dos bytes crus do vetor têm de verificar e voltar aos mesmos bytes
func TestVerifiesVectorBlocks(t *testing.T) {
	v := loadVector(t)
	var chain []Block
	for _, name := range []string{"genesis", "block1"} {
		raw, err := hex.DecodeString(v[name])
		if err != nil {
			t.Fatal(err)
		}
		var b Block
		if err := b.UnmarshalBinary(raw); err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(b.MarshalBinary(), raw) {
			t.Fatalf("%s: round trip changed the bytes", name)
		}
		chain = append(chain, b)
	}
	if err, idx := ChainVerify(chain); err != None {
		t.Fatalf("vector chain rejected: %v at block %d", err, idx)
	}
	if got := string(chain[1].Data[:chain[1].Length]); got != testText {
		t.Fatalf("data = %q", got)
	}
}

// Sabotagens: cada uma tem de reprovar com o erro certo
func TestSabotage(t *testing.T) {
	cases := []struct {
		name string
		mut  func(c []Block)
		want ValidationError
		idx  int
	}{
		{"data byte", func(c []Block) { c[1].Data[0] ^= 1 }, Fraud, 1},
		{"byte past length", func(c []Block) { c[1].Data[300] = 1 }, Fraud, 1},
		{"nonce", func(c []Block) { c[0].Nonce++ }, Fraud, 0},
		{"swapped author", func(c []Block) { c[1].Author[0] ^= 1 }, Fraud, 1},
		{"length above max", func(c []Block) { c[1].Length = MaxDataLength + 1 }, InvalidLength, 1},
		{"negative length", func(c []Block) { c[1].Length = -1 }, InvalidLength, 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := testChain(t)
			tc.mut(c)
			if err, idx := ChainVerify(c); err != tc.want || idx != tc.idx {
				t.Fatalf("ChainVerify = %v,%d; want %v,%d", err, idx, tc.want, tc.idx)
			}
		})
	}
}

// Sabotagens de encadeamento: o bloco é reassinado, então só o encadeamento pode reprovar
func TestSabotageChain(t *testing.T) {
	key := testKey(t)
	cases := []struct {
		name string
		mut  func(b *Block)
		want ValidationError
	}{
		{"prev", func(b *Block) { b.Prev[0] ^= 1 }, NoHashContinuity},
		{"room", func(b *Block) { b.Room[0] = 'X' }, InvalidRoom},
		{"time going backwards", func(b *Block) { b.Stamp = 1 }, NoTimestampContinuity},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := testChain(t)
			tc.mut(&c[1])
			c[1].Sign(key)
			if err := c[1].Verify(); err != None {
				t.Fatalf("re-signed block should pass on its own: %v", err)
			}
			if err, idx := ChainVerify(c); err != tc.want || idx != 1 {
				t.Fatalf("ChainVerify = %v,%d; want %v,1", err, idx, tc.want)
			}
		})
	}
}

func TestUpload(t *testing.T) {
	var b Block
	if err := b.UploadString(strings.Repeat("x", MaxDataLength+1)); err != ErrDataTooLong {
		t.Fatalf("err = %v", err)
	}
	if err := b.UploadString("abcdef"); err != nil {
		t.Fatal(err)
	}
	if err := b.UploadString("ab"); err != nil {
		t.Fatal(err)
	}
	if b.Length != 2 || b.Data[2] != 0 || b.Type != Text {
		t.Fatalf("upload did not clear the rest: %+v", b.Metadata)
	}
	if err := b.UploadValue([]uint32{1, 2}, Other); err != nil {
		t.Fatal(err)
	}
	if b.Length != 8 || b.Data[0] != 1 || b.Data[4] != 2 || b.Type != Other {
		t.Fatalf("UploadValue: %+v %v", b.Metadata, b.Data[:8])
	}
}

func TestNextBlockEmptyPanics(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("NextBlock with an empty chain did not panic")
		}
	}()
	_ = NextBlock(nil)
}

func TestTimestampToString(t *testing.T) {
	const ts = 1_763_490_000_123_456_789
	if got := TimestampToString(ts, -180); got != "2025-11-18T15:20:00.123456789-03:00" {
		t.Fatalf("offset -03:00: %s", got)
	}
	if got := TimestampToString(ts, 0); got != "2025-11-18T18:20:00.123456789Z" {
		t.Fatalf("UTC: %s", got)
	}
	if got := TimestampToString(1_763_490_000_000_000_000, 0); got != "2025-11-18T18:20:00Z" {
		t.Fatalf("no nanos: %s", got)
	}
}
