// O server é o lado exposto na rede: serve a página, aceita os blocos assinados pelos navegadores via WebSocket,
// repassa cada um ao validator e transmite a todos só o que o validator aceitou. O server nunca decide se um bloco é
// válido; a única coisa que ele confere é o tamanho do frame (512 bytes). Protocolo: docs/protocol.md

package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/phbnascimento/bizas-image/application/bizas"
)

const (
	validatorTimeout = 2 * time.Second
	writeTimeout     = 5 * time.Second
	sendQueue        = 64
	readLimit        = 4096 // acima disso o coder/websocket fecha a conexão
)

// Notice é o frame de texto (JSON) do server para o navegador
//
// No aviso "time", os três valores são em ns e vão como string decimal (passam de 2^53):
//   - now: relógio efetivo do validator, com o qual o navegador assina;
//   - run_start: início da execução atual do validator; carimbos anteriores são de uma sessão anterior;
//   - real_offset: hora real − hora da placa, informada pelo set-date ou set-auto-date. Ausente se ninguém a
//     informou nesta execução do validator. Só vale para carimbos a partir de run_start
type Notice struct {
	Type       string `json:"type"`                  // "time" | "rejected" | "error"
	Error      string `json:"error,omitempty"`       // nome do ValidationError ou código do server
	Head       string `json:"head,omitempty"`        // cabeça atual em hex, quando o validator a manda
	Now        string `json:"now,omitempty"`         // "time"
	RunStart   string `json:"run_start,omitempty"`   // "time"
	RealOffset string `json:"real_offset,omitempty"` // "time"
}

// calibration é o par do set-date: a diferença entre a hora real e a da placa, válida só na execução do validator em
// que foi informada (runStart). Fica só em memória, de propósito
type calibration struct {
	runStart   int64
	realOffset int64
}

// chainState é a resposta do GET /chain do validator
type chainState struct {
	data     []byte
	now      int64
	runStart int64
}

type outMsg struct {
	typ  websocket.MessageType
	data []byte
}

type client struct {
	send chan outMsg
	conn *websocket.Conn
}

// Server guarda os clientes conectados
type Server struct {
	validatorURL string
	http         *http.Client
	log          *slog.Logger

	// mu serializa a entrada de clientes (buscar o histórico e se inscrever) e os envios (repassar ao validator e
	// transmitir). Assim todo cliente vê os blocos na ordem da cadeia, sem lacuna nem repetição
	mu      sync.Mutex
	clients map[*client]struct{}
	calib   *calibration // protegido por mu
}

func New(validatorURL string, log *slog.Logger) *Server {
	return &Server{
		validatorURL: validatorURL,
		http:         &http.Client{Timeout: validatorTimeout},
		log:          log,
		clients:      map[*client]struct{}{},
	}
}

// Handler devolve as rotas públicas: /, /health, /chain, /chain.json e /ws
func (s *Server) Handler(static fs.FS) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("GET /", http.FileServerFS(static))
	mux.HandleFunc("GET /health", s.health)
	mux.HandleFunc("GET /chain", s.chain)
	mux.HandleFunc("GET /chain.json", s.chainJSON)
	mux.HandleFunc("GET /ws", s.ws)
	return mux
}

// /health só devolve 200 quando o validator também responde
func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	resp, err := s.http.Get(s.validatorURL + "/health")
	if err != nil {
		http.Error(w, "validator unavailable", http.StatusServiceUnavailable)
		return
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		http.Error(w, "validator unavailable", http.StatusServiceUnavailable)
		return
	}
	_, _ = io.WriteString(w, "ok\n")
}

// /chain repassa a cadeia do validator, para exportar e verificar fora da Pi
func (s *Server) chain(w http.ResponseWriter, r *http.Request) {
	st, err := s.fetchChain()
	if err != nil {
		http.Error(w, "validator unavailable", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", `attachment; filename="chain.bin"`)
	_, _ = w.Write(st.data)
}

// jsonBlock é um bloco legível: números grandes como string decimal e bytes em hex, só para visualização
type jsonBlock struct {
	Height int    `json:"height"`
	Room   string `json:"room"`
	Stamp  string `json:"stamp"`
	Nonce  string `json:"nonce"`
	Info   uint32 `json:"info"`
	Type   string `json:"type"`
	Length int16  `json:"length"`
	Author string `json:"author"`
	Sig    string `json:"sig"`
	Prev   string `json:"prev"`
	Text   string `json:"text,omitempty"`
}

// /chain.json devolve a cadeia formatada para leitura; quem verifica usa o /chain binário
func (s *Server) chainJSON(w http.ResponseWriter, r *http.Request) {
	st, err := s.fetchChain()
	if err != nil {
		http.Error(w, "validator unavailable", http.StatusServiceUnavailable)
		return
	}
	out := make([]jsonBlock, 0, len(st.data)/bizas.BlockSize)
	for i := 0; i+bizas.BlockSize <= len(st.data); i += bizas.BlockSize {
		var b bizas.Block
		if err := b.UnmarshalBinary(st.data[i : i+bizas.BlockSize]); err != nil {
			http.Error(w, "bad chain", http.StatusInternalServerError)
			return
		}
		jb := jsonBlock{
			Height: i / bizas.BlockSize,
			Room:   strings.TrimRight(string(b.Room[:]), "\x00"),
			Stamp:  strconv.FormatUint(uint64(b.Stamp), 10),
			Nonce:  strconv.FormatUint(b.Nonce, 10),
			Info:   b.Info,
			Type:   b.Type.String(),
			Length: b.Length,
			Author: hex.EncodeToString(b.Author[:]),
			Sig:    hex.EncodeToString(b.Sig[:]),
			Prev:   hex.EncodeToString(b.Prev[:]),
		}
		if b.Type == bizas.Text && b.Length >= 0 && int(b.Length) <= bizas.MaxDataLength {
			jb.Text = string(b.Data[:b.Length])
		}
		out = append(out, jb)
	}
	body, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Disposition", `attachment; filename="chain.json"`)
	_, _ = w.Write(append(body, '\n'))
}

// fetchChain devolve a cadeia, o relógio efetivo do validator e o início da execução dele
func (s *Server) fetchChain() (chainState, error) {
	var st chainState
	resp, err := s.http.Get(s.validatorURL + "/chain")
	if err != nil {
		return st, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return st, fmt.Errorf("validator /chain: %s", resp.Status)
	}
	if st.data, err = io.ReadAll(resp.Body); err != nil {
		return st, err
	}
	if len(st.data)%bizas.BlockSize != 0 {
		return st, fmt.Errorf("validator /chain: %d bytes, not a multiple of %d", len(st.data), bizas.BlockSize)
	}
	for _, h := range []struct {
		name string
		dst  *int64
	}{{bizas.NowHeader, &st.now}, {bizas.RunStartHeader, &st.runStart}} {
		v, err := strconv.ParseInt(resp.Header.Get(h.name), 10, 64)
		if err != nil {
			return st, fmt.Errorf("validator /chain: bad %s header %q", h.name, resp.Header.Get(h.name))
		}
		*h.dst = v
	}
	return st, nil
}

// timeNotice monta o aviso "time". Chamado com s.mu travado. A calibração só vai junto se for da execução atual do
// validator: depois de um reinício dele, o par antigo não vale para os carimbos novos e é descartado
func (s *Server) timeNotice(st chainState) Notice {
	n := Notice{Type: "time", Now: strconv.FormatInt(st.now, 10), RunStart: strconv.FormatInt(st.runStart, 10)}
	if s.calib != nil && s.calib.runStart != st.runStart {
		s.log.Info("validator restarted; the set-date calibration no longer applies")
		s.calib = nil
	}
	if s.calib != nil {
		n.RealOffset = strconv.FormatInt(s.calib.realOffset, 10)
	}
	return n
}

// AdminHandler devolve as rotas de manutenção, que o main só escuta em 127.0.0.1 dentro do container (nunca na porta
// publicada). POST /clock com a hora real em ns (string decimal) grava a calibração e avisa todas as páginas abertas
func (s *Server) AdminHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /clock", func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64))
		if err != nil {
			http.Error(w, "body too large", http.StatusBadRequest)
			return
		}
		real, err := strconv.ParseInt(strings.TrimSpace(string(body)), 10, 64)
		if err != nil {
			http.Error(w, "body must be the real time in ns since 1970", http.StatusBadRequest)
			return
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		st, err := s.fetchChain()
		if err != nil {
			http.Error(w, "validator unavailable", http.StatusServiceUnavailable)
			return
		}
		s.calib = &calibration{runStart: st.runStart, realOffset: real - st.now}
		n := s.timeNotice(st)
		for c := range s.clients {
			s.notify(c, n)
		}
		s.log.Info("clock calibrated", "real", time.Unix(0, real).UTC().Format(time.RFC3339), "offset_ns", s.calib.realOffset)
		fmt.Fprintf(w, "ok: board time %d ns maps to %s\n", st.now, time.Unix(0, real).UTC().Format(time.RFC3339))
	})
	return mux
}

func (s *Server) ws(w http.ResponseWriter, r *http.Request) {
	// AcceptOptions vazio: o coder/websocket recusa Origin diferente do Host
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(readLimit)

	c := &client{send: make(chan outMsg, sendQueue), conn: conn}
	if err := s.join(c); err != nil {
		s.log.Warn("history unavailable", "err", err)
		conn.Close(websocket.StatusTryAgainLater, "validator unavailable")
		return
	}
	defer s.leave(c)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	go s.writer(ctx, c, cancel)

	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		if typ != websocket.MessageBinary || len(data) != bizas.BlockSize {
			s.notify(c, Notice{Type: "error", Error: "INVALID_SIZE"})
			continue
		}
		s.submit(c, data)
	}
}

// join busca o histórico e inscreve o cliente sob o mesmo lock dos envios. O cliente recebe primeiro o relógio do
// validator (aviso "time"), com o qual assina, e depois o histórico (talvez vazio): o primeiro frame binário é sempre
// ele
func (s *Server) join(c *client) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, err := s.fetchChain()
	if err != nil {
		return err
	}
	s.notify(c, s.timeNotice(st))
	c.send <- outMsg{websocket.MessageBinary, st.data}
	s.clients[c] = struct{}{}
	return nil
}

func (s *Server) leave(c *client) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.clients, c)
}

func (s *Server) writer(ctx context.Context, c *client, cancel context.CancelFunc) {
	defer cancel()
	for {
		select {
		case <-ctx.Done():
			return
		case m, ok := <-c.send:
			if !ok {
				return
			}
			wctx, wcancel := context.WithTimeout(ctx, writeTimeout)
			err := c.conn.Write(wctx, m.typ, m.data)
			wcancel()
			if err != nil {
				return
			}
		}
	}
}

// submit repassa o bloco ao validator e, se aceito, transmite a todos (inclusive a quem enviou, que usa isso como
// confirmação)
func (s *Server) submit(from *client, block []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()

	resp, err := s.http.Post(s.validatorURL+"/blocks", "application/octet-stream", bytes.NewReader(block))
	if err != nil {
		s.log.Warn("validator unavailable", "err", err)
		s.notify(from, Notice{Type: "error", Error: "VALIDATOR_UNAVAILABLE"})
		return
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		var rej struct {
			Error string `json:"error"`
			Head  string `json:"head"`
		}
		if err := json.Unmarshal(body, &rej); err != nil || rej.Error == "" {
			rej.Error = "VALIDATOR_" + resp.Status
		}
		s.notify(from, Notice{Type: "rejected", Error: rej.Error, Head: rej.Head})
		return
	}

	for c := range s.clients {
		select {
		case c.send <- outMsg{websocket.MessageBinary, block}:
		default:
			// Cliente lento demais: desconecta; ao voltar, recebe o histórico
			s.log.Warn("slow client disconnected")
			delete(s.clients, c)
			c.conn.CloseNow()
		}
	}
}

// notify manda um aviso só para um cliente, sem bloquear
func (s *Server) notify(c *client, n Notice) {
	data, err := json.Marshal(n)
	if err != nil {
		return
	}
	select {
	case c.send <- outMsg{websocket.MessageText, data}:
	default:
	}
}

// WaitValidator tenta /health do validator até responder ou ctx acabar. Usado só para registrar no log quando o
// validator ficou de pé; o server atende desde o início e o /health dele reflete o estado real
func (s *Server) WaitValidator(ctx context.Context) error {
	for {
		resp, err := s.http.Get(s.validatorURL + "/health")
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return errors.Join(ctx.Err(), err)
		case <-time.After(200 * time.Millisecond):
		}
	}
}
