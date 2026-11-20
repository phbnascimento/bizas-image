package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/coder/websocket"
	"github.com/phbnascimento/bizas-image/application/bizas"
)

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

// stack sobe um validator real e o server apontando para ele
func stack(t *testing.T) (srv, val *httptest.Server) {
	t.Helper()
	var chain bizas.Chain
	val = httptest.NewServer(bizas.ValidatorHandler(&chain, quiet))
	t.Cleanup(val.Close)
	s := New(val.URL, quiet)
	static := fstest.MapFS{"index.html": {Data: []byte("page")}}
	srv = httptest.NewServer(s.Handler(static))
	t.Cleanup(srv.Close)
	return srv, val
}

func dial(t *testing.T, srv *httptest.Server) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.CloseNow() })
	// Ao entrar, o primeiro frame é o relógio do validator, para o navegador assinar com ele
	n := readNotice(t, c)
	now, err := strconv.ParseInt(n.Now, 10, 64)
	if n.Type != "time" || err != nil {
		t.Fatalf("first frame is not a time notice: %+v", n)
	}
	if d := time.Duration(now - time.Now().UnixNano()); d < -time.Minute || d > time.Minute {
		t.Fatalf("validator time %d is %v away from this clock", now, d)
	}
	return c
}

func read(t *testing.T, c *websocket.Conn) (websocket.MessageType, []byte) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	typ, data, err := c.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	return typ, data
}

func write(t *testing.T, c *websocket.Conn, typ websocket.MessageType, data []byte) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := c.Write(ctx, typ, data); err != nil {
		t.Fatal(err)
	}
}

func readNotice(t *testing.T, c *websocket.Conn) Notice {
	t.Helper()
	typ, data := read(t, c)
	if typ != websocket.MessageText {
		t.Fatalf("expected a text notice, got %d binary bytes", len(data))
	}
	var n Notice
	if err := json.Unmarshal(data, &n); err != nil {
		t.Fatal(err)
	}
	return n
}

func signed(t *testing.T, seed byte, prev *bizas.Block, text string) bizas.Block {
	t.Helper()
	k, err := bizas.GetPrivKey(bytes.Repeat([]byte{seed}, 32))
	if err != nil {
		t.Fatal(err)
	}
	var b bizas.Block
	if prev == nil {
		b.Room = bizas.DefaultRoomName
		b.Stamp = 1_000
	} else {
		b = bizas.NextBlock([]bizas.Block{*prev})
		b.Stamp = prev.Stamp + 1
	}
	if err := b.UploadString(text); err != nil {
		t.Fatal(err)
	}
	b.Sign(k)
	return b
}

func TestBroadcastOnlyAccepted(t *testing.T) {
	srv, _ := stack(t)
	alice, bob := dial(t, srv), dial(t, srv)
	for _, c := range []*websocket.Conn{alice, bob} {
		if typ, h := read(t, c); typ != websocket.MessageBinary || len(h) != 0 {
			t.Fatalf("initial history: type %v, %d bytes", typ, len(h))
		}
	}

	g := signed(t, 1, nil, "genesis")
	write(t, alice, websocket.MessageBinary, g.MarshalBinary())
	for name, c := range map[string]*websocket.Conn{"alice": alice, "bob": bob} {
		if _, data := read(t, c); !bytes.Equal(data, g.MarshalBinary()) {
			t.Fatalf("%s did not receive the genesis", name)
		}
	}

	// Bob assina sobre a cabeça velha: só ele recebe a recusa, com a cabeça
	first := signed(t, 1, &g, "first")
	stale := signed(t, 2, &g, "stale")
	write(t, alice, websocket.MessageBinary, first.MarshalBinary())
	read(t, alice)
	if _, data := read(t, bob); !bytes.Equal(data, first.MarshalBinary()) {
		t.Fatal("bob did not receive the first block")
	}
	write(t, bob, websocket.MessageBinary, stale.MarshalBinary())
	n := readNotice(t, bob)
	if n.Type != "rejected" || n.Error != "NO_HASH_CONTINUITY" || n.Head != hex.EncodeToString(first.MarshalBinary()) {
		t.Fatalf("wrong rejection: %+v", n)
	}

	// Quem conecta depois recebe o histórico completo num frame só
	carol := dial(t, srv)
	if _, h := read(t, carol); !bytes.Equal(h, append(g.MarshalBinary(), first.MarshalBinary()...)) {
		t.Fatalf("carol's history has %d bytes", len(h))
	}

	// Alice não pode ter recebido o bloco recusado: a próxima coisa que ela recebe é o próximo bloco aceito
	next := signed(t, 2, &first, "now it fits")
	write(t, bob, websocket.MessageBinary, next.MarshalBinary())
	if _, data := read(t, alice); !bytes.Equal(data, next.MarshalBinary()) {
		t.Fatal("alice received something other than the accepted block")
	}
}

func TestWrongFrame(t *testing.T) {
	srv, _ := stack(t)
	c := dial(t, srv)
	read(t, c)
	write(t, c, websocket.MessageBinary, make([]byte, 511))
	if n := readNotice(t, c); n.Type != "error" || n.Error != "INVALID_SIZE" {
		t.Fatalf("511 bytes: %+v", n)
	}
	write(t, c, websocket.MessageText, make([]byte, 512))
	if n := readNotice(t, c); n.Error != "INVALID_SIZE" {
		t.Fatalf("text frame: %+v", n)
	}
}

// O coder/websocket recusa Origin diferente do Host quando AcceptOptions é nil
func TestForeignOriginRefused(t *testing.T) {
	srv, _ := stack(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	h := http.Header{"Origin": {"http://atacante.example"}}
	c, resp, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/ws", &websocket.DialOptions{HTTPHeader: h})
	if err == nil {
		c.CloseNow()
		t.Fatal("connection with a foreign Origin was accepted")
	}
	if resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Fatalf("want 403, got %v", resp)
	}
}

// Frame acima do limite de leitura fecha a conexão
func TestOversizedFrameClosesConnection(t *testing.T) {
	srv, _ := stack(t)
	c := dial(t, srv)
	read(t, c)
	write(t, c, websocket.MessageBinary, make([]byte, readLimit+1))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _, err := c.Read(ctx)
	if websocket.CloseStatus(err) != websocket.StatusMessageTooBig {
		t.Fatalf("want close 1009 (StatusMessageTooBig), got %v", err)
	}
}

func TestHealthFollowsValidator(t *testing.T) {
	srv, val := stack(t)
	get := func() int {
		resp, err := http.Get(srv.URL + "/health")
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	if st := get(); st != 200 {
		t.Fatalf("/health with validator up: %d", st)
	}
	val.Close()
	if st := get(); st != http.StatusServiceUnavailable {
		t.Fatalf("/health with validator down: %d", st)
	}
}

func TestValidatorDownOnSubmit(t *testing.T) {
	srv, val := stack(t)
	c := dial(t, srv)
	read(t, c)
	val.Close()
	g := signed(t, 1, nil, "genesis")
	write(t, c, websocket.MessageBinary, g.MarshalBinary())
	if n := readNotice(t, c); n.Type != "error" || n.Error != "VALIDATOR_UNAVAILABLE" {
		t.Fatalf("%+v", n)
	}
}

func TestStaticAndChain(t *testing.T) {
	srv, _ := stack(t)
	resp, err := http.Get(srv.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(body) != "page" {
		t.Fatalf("/ returned %q", body)
	}
	resp, err = http.Get(srv.URL + "/chain")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "application/octet-stream" {
		t.Fatalf("/chain: %d %s", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
}

// swapHandler deixa trocar o validator por trás do mesmo endereço, simulando um reinício dele
type swapHandler struct {
	mu sync.Mutex
	h  http.Handler
}

func (s *swapHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	h := s.h
	s.mu.Unlock()
	h.ServeHTTP(w, r)
}

func TestSetDateCalibration(t *testing.T) {
	var chain1 bizas.Chain
	sw := &swapHandler{h: bizas.ValidatorHandler(&chain1, quiet)}
	val := httptest.NewServer(sw)
	defer val.Close()
	s := New(val.URL, quiet)
	srv := httptest.NewServer(s.Handler(fstest.MapFS{"index.html": {Data: []byte("page")}}))
	defer srv.Close()
	admin := httptest.NewServer(s.AdminHandler())
	defer admin.Close()

	c := dial(t, srv)
	read(t, c) // histórico

	// Rota de manutenção não existe na porta pública
	if resp, err := http.Post(srv.URL+"/clock", "text/plain", strings.NewReader("1")); err != nil || resp.StatusCode == 200 {
		t.Fatalf("public /clock answered: %v %v", resp, err)
	}
	if resp, _ := http.Post(admin.URL+"/clock", "text/plain", strings.NewReader("not a number")); resp.StatusCode != 400 {
		t.Fatalf("bad body: %d", resp.StatusCode)
	}

	real := time.Date(2026, 11, 20, 3, 39, 55, 0, time.UTC).UnixNano()
	resp, err := http.Post(admin.URL+"/clock", "text/plain", strings.NewReader(strconv.FormatInt(real, 10)))
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("POST /clock: %v %v", resp, err)
	}
	// A página aberta recebe a calibração na hora
	n := readNotice(t, c)
	off, err := strconv.ParseInt(n.RealOffset, 10, 64)
	if n.Type != "time" || err != nil {
		t.Fatalf("open page got %+v", n)
	}
	now, _ := strconv.ParseInt(n.Now, 10, 64)
	if d := time.Duration(now + off - real); d < -time.Second || d > time.Second {
		t.Fatalf("board time + offset is %v away from the real time given", d)
	}
	// Quem conecta depois também recebe
	c2, _, _ := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(srv.URL, "http")+"/ws", nil)
	defer c2.CloseNow()
	if n2 := readNotice(t, c2); n2.RealOffset != n.RealOffset {
		t.Fatalf("new page got %+v", n2)
	}

	// Validator reiniciado (outra execução, outro run_start): a calibração não vale mais
	time.Sleep(2 * time.Millisecond)
	var chain2 bizas.Chain
	sw.mu.Lock()
	sw.h = bizas.ValidatorHandler(&chain2, quiet)
	sw.mu.Unlock()
	c3, _, _ := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(srv.URL, "http")+"/ws", nil)
	defer c3.CloseNow()
	if n3 := readNotice(t, c3); n3.Type != "time" || n3.RealOffset != "" || n3.RunStart == n.RunStart {
		t.Fatalf("after validator restart got %+v (before: run_start %s)", n3, n.RunStart)
	}
}
