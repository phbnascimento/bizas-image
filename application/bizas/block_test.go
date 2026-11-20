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

var vectorKeys = []string{"size", "pub", "genesis", "block1", "verify", "clz", "fingerprint"}

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

// testChain monta a cadeia do vetor; bizas.test.js monta a mesma
func testChain(t *testing.T) []Block {
	t.Helper()
	key := testKey(t)

	var genesis Block
	genesis.Room = DefaultRoomName
	genesis.Stamp = 1_763_490_000_123_456_789
	genesis.Nonce = 0x0102030405060708
	genesis.Info = 0xA1B2C3D4
	if err := genesis.UploadString("genesis"); err != nil {
		t.Fatal(err)
	}
	genesis.Sign(key)

	b := NextBlock([]Block{genesis})
	b.Stamp = 1_763_490_001_000_000_000
	b.Nonce = 42
	b.Info = 7
	if err := b.UploadString(testText); err != nil {
		t.Fatal(err)
	}
	b.Sign(key)
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
	fmt.Fprintf(&sb, "clz=%d\n", CountLeadingZeroBits([]byte{0, 0, 0x10, 0xff}))
	fp, err := Fingerprint(chain, len(chain))
	if err != nil {
		t.Fatal(err)
	}
	fmt.Fprintf(&sb, "fingerprint=%s\n", fp)
	return sb.String()
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
