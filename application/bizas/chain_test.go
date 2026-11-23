package bizas

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func key(t *testing.T, n byte) PrivateKey {
	t.Helper()
	seed := bytes.Repeat([]byte{n}, 32)
	k, err := GetPrivKey(seed)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func block(t *testing.T, k PrivateKey, prev *Block, text string) Block {
	t.Helper()
	var b Block
	if prev == nil {
		b.Room = DefaultRoomName
		b.Stamp = 1_000
	} else {
		b = NextBlock([]Block{*prev})
		b.Stamp = prev.Stamp + 1
	}
	if err := b.UploadString(text); err != nil {
		t.Fatal(err)
	}
	b.Sign(k)
	return b
}

type fixture struct {
	t   *testing.T
	srv *httptest.Server
}

func newFixture(t *testing.T) *fixture {
	var c Chain
	srv := httptest.NewServer(ValidatorHandler(&c, slog.New(slog.NewTextHandler(io.Discard, nil))))
	t.Cleanup(srv.Close)
	return &fixture{t, srv}
}

func (f *fixture) post(body []byte) (int, Rejection) {
	f.t.Helper()
	resp, err := http.Post(f.srv.URL+"/blocks", "application/octet-stream", bytes.NewReader(body))
	if err != nil {
		f.t.Fatal(err)
	}
	defer resp.Body.Close()
	var rej Rejection
	if resp.StatusCode != http.StatusOK {
		if err := json.NewDecoder(resp.Body).Decode(&rej); err != nil {
			f.t.Fatalf("rejection without JSON: %v", err)
		}
	}
	return resp.StatusCode, rej
}

func (f *fixture) chain() []byte {
	f.t.Helper()
	resp, err := http.Get(f.srv.URL + "/chain")
	if err != nil {
		f.t.Fatal(err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		f.t.Fatal(err)
	}
	return data
}

func TestAcceptAndChain(t *testing.T) {
	f := newFixture(t)
	if n := len(f.chain()); n != 0 {
		t.Fatalf("new chain has %d bytes", n)
	}
	a, b := key(t, 1), key(t, 2)
	g := block(t, a, nil, "genesis")
	if st, rej := f.post(g.MarshalBinary()); st != 200 {
		t.Fatalf("genesis rejected: %d %+v", st, rej)
	}
	n1 := block(t, b, &g, "hi")
	if st, rej := f.post(n1.MarshalBinary()); st != 200 {
		t.Fatalf("block 1 rejected: %d %+v", st, rej)
	}
	want := append(g.MarshalBinary(), n1.MarshalBinary()...)
	if got := f.chain(); !bytes.Equal(got, want) {
		t.Fatalf("/chain returned %d bytes that differ from the expected", len(got))
	}
}

// Dois aparelhos assinam sobre a mesma cabeça: o segundo é recusado e recebe a cabeça nova
func TestStalePrevRejectedWithHead(t *testing.T) {
	f := newFixture(t)
	a, b := key(t, 1), key(t, 2)
	g := block(t, a, nil, "genesis")
	f.post(g.MarshalBinary())
	first := block(t, a, &g, "first")
	second := block(t, b, &g, "second")
	if st, _ := f.post(first.MarshalBinary()); st != 200 {
		t.Fatal("first block rejected")
	}
	st, rej := f.post(second.MarshalBinary())
	if st != http.StatusConflict || rej.Error != "NO_HASH_CONTINUITY" {
		t.Fatalf("want 409 NO_HASH_CONTINUITY, got %d %+v", st, rej)
	}
	if rej.Head != hex.EncodeToString(first.MarshalBinary()) {
		t.Fatal("returned head is not the accepted block")
	}
}

func TestRejections(t *testing.T) {
	a := key(t, 1)
	cases := []struct {
		name   string
		body   func(g Block) []byte
		status int
		code   string
	}{
		{"511 bytes", func(g Block) []byte { return make([]byte, 511) }, 400, "INVALID_SIZE"},
		{"513 bytes", func(g Block) []byte { return make([]byte, 513) }, 413, "INVALID_SIZE"},
		{"tampered signature", func(g Block) []byte {
			n := block(t, a, &g, "x")
			n.Data[0] ^= 1
			return n.MarshalBinary()
		}, 409, "FRAUD"},
		{"second genesis", func(g Block) []byte {
			other := block(t, a, nil, "another")
			return other.MarshalBinary()
		}, 409, "NO_HASH_CONTINUITY"},
		{"time going backwards", func(g Block) []byte {
			n := NextBlock([]Block{g})
			n.Stamp = g.Stamp - 1
			n.Sign(a)
			return n.MarshalBinary()
		}, 409, "NO_TIMESTAMP_CONTINUITY"},
		{"other room", func(g Block) []byte {
			n := NextBlock([]Block{g})
			n.Room = Room{'X'}
			n.Sign(a)
			return n.MarshalBinary()
		}, 409, "INVALID_ROOM"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t)
			g := block(t, a, nil, "genesis")
			f.post(g.MarshalBinary())
			st, rej := f.post(tc.body(g))
			if st != tc.status || rej.Error != tc.code {
				t.Fatalf("want %d %s, got %d %+v", tc.status, tc.code, st, rej)
			}
			if n := len(f.chain()); n != BlockSize {
				t.Fatalf("rejection changed the chain: %d bytes", n)
			}
		})
	}
}

// signWithoutWork assina o bloco num nonce cuja assinatura não começa com workBits bits zero (o oposto de Mine)
func signWithoutWork(k PrivateKey, b *Block, workBits uint32) {
	for {
		b.Sign(k)
		if !b.HasWork(workBits) {
			return
		}
		b.Nonce++
	}
}

// Prova de trabalho: o info do gênese é o N da cadeia, e toda assinatura, inclusive a do gênese, começa com N bits zero
func TestProofOfWork(t *testing.T) {
	const n = 6
	a, b := key(t, 1), key(t, 2)
	genesis := func() Block {
		g := block(t, a, nil, "genesis")
		g.Info = n
		g.Mine(a, n)
		return g
	}

	t.Run("mined blocks are accepted", func(t *testing.T) {
		f := newFixture(t)
		g := genesis()
		if st, rej := f.post(g.MarshalBinary()); st != 200 {
			t.Fatalf("mined genesis: %d %+v", st, rej)
		}
		next := NextBlock([]Block{g})
		next.Stamp = g.Stamp + 1
		next.UploadString("mined by someone else")
		next.Mine(b, n)
		if st, rej := f.post(next.MarshalBinary()); st != 200 {
			t.Fatalf("mined block: %d %+v", st, rej)
		}
		if CountLeadingZeroBits(next.Sig[:]) < n {
			t.Fatal("Mine returned a signature without the work")
		}
	})
	t.Run("block without work", func(t *testing.T) {
		f := newFixture(t)
		g := genesis()
		f.post(g.MarshalBinary())
		next := NextBlock([]Block{g})
		next.Stamp = g.Stamp + 1
		next.UploadString("lazy")
		signWithoutWork(b, &next, n)
		st, rej := f.post(next.MarshalBinary())
		if st != 409 || rej.Error != "INSUFFICIENT_WORK" || rej.Head == "" {
			t.Fatalf("want 409 INSUFFICIENT_WORK with the head, got %d %+v", st, rej)
		}
		if got := len(f.chain()); got != BlockSize {
			t.Fatalf("rejection changed the chain: %d bytes", got)
		}
	})
	t.Run("genesis without its own work", func(t *testing.T) {
		f := newFixture(t)
		g := block(t, a, nil, "genesis")
		g.Info = n
		signWithoutWork(a, &g, n)
		if st, rej := f.post(g.MarshalBinary()); st != 409 || rej.Error != "INSUFFICIENT_WORK" {
			t.Fatalf("want 409 INSUFFICIENT_WORK, got %d %+v", st, rej)
		}
	})
	t.Run("genesis asking more than MaxWorkBits", func(t *testing.T) {
		f := newFixture(t)
		g := block(t, a, nil, "genesis")
		g.Info = MaxWorkBits + 1
		g.Sign(a)
		if st, rej := f.post(g.MarshalBinary()); st != 409 || rej.Error != "INVALID_WORK_BITS" {
			t.Fatalf("want 409 INVALID_WORK_BITS, got %d %+v", st, rej)
		}
	})
	t.Run("the whole chain is checked against the genesis", func(t *testing.T) {
		g := genesis()
		next := NextBlock([]Block{g})
		next.Stamp = g.Stamp + 1
		next.UploadString("lazy")
		signWithoutWork(b, &next, n)
		if e, i := VerifyChain([]Block{g, next}); e != InsufficientWork || i != 1 {
			t.Fatalf("VerifyChain = %v,%d; want INSUFFICIENT_WORK,1", e, i)
		}
		big := block(t, a, nil, "genesis")
		big.Info = MaxWorkBits + 1
		big.Sign(a)
		if e, i := VerifyChain([]Block{big}); e != InvalidWorkBits || i != 0 {
			t.Fatalf("VerifyChain = %v,%d; want INVALID_WORK_BITS,0", e, i)
		}
	})
}

func TestGenesisMustHaveZeroPrev(t *testing.T) {
	f := newFixture(t)
	g := block(t, key(t, 1), nil, "genesis")
	g.Prev[0] = 1
	g.Sign(key(t, 1))
	if st, rej := f.post(g.MarshalBinary()); st != 409 || rej.Error != "NO_HASH_CONTINUITY" || rej.Head != "" {
		t.Fatalf("genesis with non-zero prev: %d %+v", st, rej)
	}
}

func TestVerifyChain(t *testing.T) {
	a := key(t, 1)
	g := block(t, a, nil, "genesis")
	n1 := block(t, a, &g, "one")
	n2 := block(t, a, &n1, "two")
	raw := append(append(g.MarshalBinary(), n1.MarshalBinary()...), n2.MarshalBinary()...)

	chain, err := ParseChain(raw)
	if err != nil {
		t.Fatal(err)
	}
	if e, i := VerifyChain(chain); e != None || i != -1 {
		t.Fatalf("valid chain rejected: %v,%d", e, i)
	}
	if _, err := ParseChain(raw[:len(raw)-1]); err == nil {
		t.Fatal("accepted a truncated file")
	}

	bad := bytes.Clone(raw)
	bad[2*BlockSize+200] ^= 1
	chain, _ = ParseChain(bad)
	if e, i := VerifyChain(chain); e != Fraud || i != 2 {
		t.Fatalf("byte changed in block 2: %v,%d", e, i)
	}

	// Gênese trocada por outra válida, mas com prev não zerado
	fake := block(t, a, nil, "genesis")
	fake.Prev[0] = 1
	fake.Sign(a)
	chain, _ = ParseChain(append(fake.MarshalBinary(), raw[BlockSize:]...))
	if e, i := VerifyChain(chain); e != NoHashContinuity || i != 0 {
		t.Fatalf("genesis with prev: %v,%d", e, i)
	}
}

func TestFingerprint(t *testing.T) {
	a, b := key(t, 1), key(t, 2)
	g := block(t, a, nil, "genesis")
	n1 := block(t, b, &g, "one")
	n2 := block(t, a, &n1, "two")
	chain := []Block{g, n1, n2}

	fp, err := Fingerprint(chain, 3)
	if err != nil || fp != hex.EncodeToString(n2.Sig[:FingerprintSize]) || len(fp) != 2*FingerprintSize {
		t.Fatalf("Fingerprint(3) = %q, %v", fp, err)
	}
	for _, h := range []int{0, 4, -1} {
		if _, err := Fingerprint(chain, h); err == nil {
			t.Errorf("height %d accepted", h)
		}
	}

	// Mesma altura, histórico diferente antes dela: a impressão digital muda
	other := block(t, b, &g, "ONE")
	fork := []Block{g, other, block(t, a, &other, "two")}
	if f2, _ := Fingerprint(fork, 3); f2 == fp {
		t.Fatal("different history, same fingerprint")
	}
	// Mesmo histórico até a altura 2: a impressão digital é a mesma, não importa o que veio depois
	f2a, _ := Fingerprint(chain, 2)
	f2b, _ := Fingerprint([]Block{g, n1}, 2)
	if f2a != f2b {
		t.Fatal("same history up to height 2, different fingerprints")
	}
}

func blockAt(t *testing.T, k PrivateKey, prev *Block, text string, stamp Timestamp) Block {
	t.Helper()
	var b Block
	if prev == nil {
		b.Room = DefaultRoomName
	} else {
		b = NextBlock([]Block{*prev})
	}
	b.Stamp = stamp
	if err := b.UploadString(text); err != nil {
		t.Fatal(err)
	}
	b.Sign(k)
	return b
}

var quietLog = slog.New(slog.NewTextHandler(io.Discard, nil))

func mustAppend(t *testing.T, c *Chain, b Block) {
	t.Helper()
	if verr, _, err := c.Append(b); verr != None || err != nil {
		t.Fatalf("Append: %v, %v", verr, err)
	}
}

func fileSize(t *testing.T, path string) int64 {
	t.Helper()
	st, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return st.Size()
}

func TestPersistAndReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "chain.bin")
	c, err := OpenChain(path, quietLog)
	if err != nil {
		t.Fatal(err)
	}
	a := key(t, 1)
	g := block(t, a, nil, "genesis")
	n1 := block(t, a, &g, "one")
	mustAppend(t, c, g)
	mustAppend(t, c, n1)
	want := c.Bytes()
	c.Close()

	// O arquivo é a própria cadeia exportável: os mesmos 512 bytes por bloco do GET /chain
	disk, _ := os.ReadFile(path)
	if !bytes.Equal(disk, want) {
		t.Fatal("file content differs from the chain")
	}
	c2, err := OpenChain(path, quietLog)
	if err != nil {
		t.Fatal(err)
	}
	defer c2.Close()
	if !bytes.Equal(c2.Bytes(), want) {
		t.Fatal("reopened chain differs")
	}
	mustAppend(t, c2, block(t, a, &n1, "two"))
	if fileSize(t, path) != 3*BlockSize {
		t.Fatalf("file has %d bytes after the third block", fileSize(t, path))
	}
}

// Queda de energia no meio de uma escrita: o pedaço final incompleto é descartado
func TestIncompleteTailDropped(t *testing.T) {
	path := filepath.Join(t.TempDir(), "chain.bin")
	c, _ := OpenChain(path, quietLog)
	a := key(t, 1)
	g := block(t, a, nil, "genesis")
	mustAppend(t, c, g)
	mustAppend(t, c, block(t, a, &g, "one"))
	want := c.Bytes()
	c.Close()

	f, _ := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0)
	f.Write(bytes.Repeat([]byte{0xAB}, 300))
	f.Close()

	c2, err := OpenChain(path, quietLog)
	if err != nil {
		t.Fatal(err)
	}
	defer c2.Close()
	if !bytes.Equal(c2.Bytes(), want) || fileSize(t, path) != 2*BlockSize {
		t.Fatalf("incomplete tail not dropped: %d blocks, file %d bytes", c2.Len(), fileSize(t, path))
	}
}

// Bloco inteiro inválido no meio: o prefixo válido fica, o resto vai para a quarentena sem ser apagado
func TestCorruptBlockQuarantined(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "chain.bin")
	c, _ := OpenChain(path, quietLog)
	a := key(t, 1)
	g := block(t, a, nil, "genesis")
	n1 := block(t, a, &g, "one")
	mustAppend(t, c, g)
	mustAppend(t, c, n1)
	mustAppend(t, c, block(t, a, &n1, "two"))
	all := c.Bytes()
	c.Close()

	raw, _ := os.ReadFile(path)
	raw[BlockSize+200] ^= 1 // dado do bloco 1
	os.WriteFile(path, raw, 0o644)

	c2, err := OpenChain(path, quietLog)
	if err != nil {
		t.Fatal(err)
	}
	defer c2.Close()
	if c2.Len() != 1 || !bytes.Equal(c2.Bytes(), all[:BlockSize]) || fileSize(t, path) != BlockSize {
		t.Fatalf("kept %d blocks, file %d bytes", c2.Len(), fileSize(t, path))
	}
	q, _ := filepath.Glob(path + ".quarantine-*")
	if len(q) != 1 {
		t.Fatalf("quarantine files: %v", q)
	}
	moved, _ := os.ReadFile(q[0])
	if !bytes.Equal(moved, raw[BlockSize:]) {
		t.Fatal("quarantine does not hold the removed blocks exactly")
	}
}

// Falha de escrita: o bloco é recusado com ErrStorage, e nem a memória nem o arquivo mudam
func TestStorageErrorLeavesChainUnchanged(t *testing.T) {
	path := filepath.Join(t.TempDir(), "chain.bin")
	c, _ := OpenChain(path, quietLog)
	a := key(t, 1)
	g := block(t, a, nil, "genesis")
	mustAppend(t, c, g)
	c.file.Close()
	ro, err := os.Open(path) // só leitura: a escrita falha
	if err != nil {
		t.Fatal(err)
	}
	c.file = ro
	defer c.Close()

	verr, _, err := c.Append(block(t, a, &g, "one"))
	if !errors.Is(err, ErrStorage) || verr != None {
		t.Fatalf("Append = %v, %v; want ErrStorage", verr, err)
	}
	if c.Len() != 1 || fileSize(t, path) != BlockSize {
		t.Fatalf("chain changed: %d blocks, file %d bytes", c.Len(), fileSize(t, path))
	}

	srv := httptest.NewServer(ValidatorHandler(c, quietLog))
	defer srv.Close()
	n1 := block(t, a, &g, "one")
	resp, err := http.Post(srv.URL+"/blocks", "application/octet-stream", bytes.NewReader(n1.MarshalBinary()))
	if err != nil {
		t.Fatal(err)
	}
	var rej Rejection
	json.NewDecoder(resp.Body).Decode(&rej)
	resp.Body.Close()
	if resp.StatusCode != http.StatusInternalServerError || rej.Error != "STORAGE_ERROR" {
		t.Fatalf("HTTP %d %+v; want 500 STORAGE_ERROR", resp.StatusCode, rej)
	}
}

// fakeClock é um relógio que só anda quando o teste manda
type fakeClock struct{ t time.Time }

func (f *fakeClock) now() time.Time { return f.t }

// Congelamento: um carimbo além de MaxFutureSkew do relógio efetivo é recusado
func TestFutureTimestampRejected(t *testing.T) {
	clk := &fakeClock{time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)}
	c, err := openChain(filepath.Join(t.TempDir(), "chain.bin"), quietLog, clk.now)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	a := key(t, 1)
	now := clk.t.UnixNano()

	if verr, _, _ := c.Append(blockAt(t, a, nil, "genesis", now+int64(time.Hour))); verr != TimestampInFuture {
		t.Fatalf("genesis one hour ahead: %v", verr)
	}
	g := blockAt(t, a, nil, "genesis", now)
	mustAppend(t, c, g)
	verr, head, _ := c.Append(blockAt(t, a, &g, "year 2100", time.Date(2100, 1, 1, 0, 0, 0, 0, time.UTC).UnixNano()))
	if verr != TimestampInFuture || head == nil || head.Sig != g.Sig {
		t.Fatalf("year 2100: %v (head returned: %v)", verr, head != nil)
	}
	mustAppend(t, c, blockAt(t, a, &g, "within the skew", now+int64(MaxFutureSkew)))
	if c.Len() != 2 {
		t.Fatalf("%d blocks", c.Len())
	}
}

// Reboot com o relógio da placa atrasado (sem RTC e sem internet): a cadeia gravada está "no futuro" para esse relógio,
// carrega mesmo assim, e o relógio efetivo continua depois da cabeça
func TestRebootWithClockBehind(t *testing.T) {
	path := filepath.Join(t.TempDir(), "chain.bin")
	day := &fakeClock{time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)}
	c, _ := openChain(path, quietLog, day.now)
	a := key(t, 1)
	g := blockAt(t, a, nil, "genesis", day.t.UnixNano())
	mustAppend(t, c, g)
	day.t = day.t.Add(time.Minute)
	head := blockAt(t, a, &g, "before power off", day.t.UnixNano())
	mustAppend(t, c, head)
	c.Close()

	boot := &fakeClock{time.Unix(5, 0)} // a placa acorda achando que é 1970
	c2, err := openChain(path, quietLog, boot.now)
	if err != nil {
		t.Fatal(err)
	}
	defer c2.Close()
	if c2.Len() != 2 {
		t.Fatalf("stored chain not loaded: %d blocks", c2.Len())
	}
	if c2.Now() < head.Stamp {
		t.Fatalf("effective clock %d is behind the head %d", c2.Now(), head.Stamp)
	}
	boot.t = boot.t.Add(3 * time.Second)
	next := blockAt(t, a, &head, "after reboot", c2.Now())
	mustAppend(t, c2, next)
	if verr, _, _ := c2.Append(blockAt(t, a, &next, "far ahead", next.Stamp+int64(time.Hour))); verr != TimestampInFuture {
		t.Fatalf("far ahead after reboot: %v", verr)
	}
}

func TestChainSendsValidatorClock(t *testing.T) {
	var c Chain
	srv := httptest.NewServer(ValidatorHandler(&c, quietLog))
	defer srv.Close()
	resp, err := http.Get(srv.URL + "/chain")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	now, err := strconv.ParseInt(resp.Header.Get(NowHeader), 10, 64)
	if err != nil {
		t.Fatalf("%s: %v", NowHeader, err)
	}
	if d := time.Duration(now - time.Now().UnixNano()); d < -time.Minute || d > time.Minute {
		t.Fatalf("validator clock %v away", d)
	}
	runStart, err := strconv.ParseInt(resp.Header.Get(RunStartHeader), 10, 64)
	if err != nil || runStart > now {
		t.Fatalf("%s = %q (now %d)", RunStartHeader, resp.Header.Get(RunStartHeader), now)
	}
}

// O início da execução é o relógio efetivo na partida: com a placa atrasada, é a cabeça gravada
func TestRunStartAfterRebootWithClockBehind(t *testing.T) {
	path := filepath.Join(t.TempDir(), "chain.bin")
	day := &fakeClock{time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)}
	c, _ := openChain(path, quietLog, day.now)
	g := blockAt(t, key(t, 1), nil, "genesis", day.t.UnixNano())
	mustAppend(t, c, g)
	c.Close()

	boot := &fakeClock{time.Unix(5, 0)}
	c2, _ := openChain(path, quietLog, boot.now)
	defer c2.Close()
	boot.t = boot.t.Add(time.Minute)
	if c2.RunStart() != g.Stamp || c2.Now() != g.Stamp+int64(time.Minute) {
		t.Fatalf("run start %d, now %d; head %d", c2.RunStart(), c2.Now(), g.Stamp)
	}
}
