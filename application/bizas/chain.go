// Chain e ValidatorHandler são o núcleo do validator: o único dono da cadeia, que confere cada bloco novo contra a
// cabeça e só então o acrescenta. O binário fica em application/validator; ele não tem porta no host e só o server fala
// com ele
//
// Persistência: a cadeia é um arquivo só de acréscimo com os mesmos blocos de 512 bytes do GET /chain (o validator
// verify lê esse arquivo direto). Nada além da cadeia é guardado. Cada bloco é gravado com fsync antes de ser
// confirmado; na partida, um pedaço final incompleto (queda de energia no meio da escrita) é descartado e o resto é
// revalidado
//
// Relógio: quem fornece a hora é a placa. O navegador assina com a hora que o validator informa, e o validator recusa
// carimbos mais que MaxFutureSkew à frente do seu relógio efetivo (ataque de congelamento: um bloco datado no futuro
// obrigaria todos os seguintes a ficar depois dele)

package bizas

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

// MaxFutureSkew é quanto um carimbo pode estar à frente do relógio efetivo do validator. Cobre a imprecisão da
// diferença de relógio que o navegador calcula; o atraso de rede só faz o carimbo ficar para trás
const MaxFutureSkew = 5 * time.Second

// NowHeader é o cabeçalho do GET /chain com o relógio efetivo do validator, em ns desde 1970 (string decimal: o valor
// passa de 2^53 e não cabe num número de JSON nem de JS)
const NowHeader = "X-Bizas-Now"

// RunStartHeader é o cabeçalho do GET /chain com o relógio efetivo no instante em que esta execução do validator
// começou. Carimbos anteriores são de uma sessão anterior: entre elas pode ter havido um período desligado que o
// relógio efetivo não conta, então a idade deles não é conhecida
const RunStartHeader = "X-Bizas-Run-Start"

// Rejection é o corpo JSON de uma recusa. Head é a cabeça atual em hex (vazia se a cadeia estiver vazia), para o
// cliente refazer o bloco
type Rejection struct {
	Error string `json:"error"`
	Head  string `json:"head,omitempty"`
}

// ErrStorage indica que o bloco era válido, mas não foi gravado; a cadeia em memória e no disco ficou como estava
var ErrStorage = errors.New("bizas: could not store the block")

// Chain guarda a cadeia aceita. O valor zero é uma cadeia vazia só em memória (usada nos testes); OpenChain dá a
// versão gravada em arquivo
type Chain struct {
	mu     sync.Mutex
	blocks []Block
	file   *os.File // nil: só em memória

	// Relógio efetivo: base + tempo decorrido desde start. A base é max(relógio da placa, carimbo da cabeça) na
	// partida, então depois de um reboot com o relógio atrasado (sem RTC e sem internet, por exemplo) as mensagens
	// novas continuam depois das gravadas
	clock func() time.Time
	base  Timestamp
	start time.Time
}

// OpenChain carrega (ou cria) a cadeia gravada em path e a mantém aberta para acréscimo
func OpenChain(path string, log *slog.Logger) (*Chain, error) {
	return openChain(path, log, time.Now)
}

func openChain(path string, log *slog.Logger, clock func() time.Time) (*Chain, error) {
	_, statErr := os.Stat(path)
	created := errors.Is(statErr, os.ErrNotExist)
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|os.O_APPEND, 0o644)
	if err != nil {
		return nil, err
	}
	if created {
		// O arquivo novo só sobrevive a uma queda de energia depois do fsync do diretório
		if err := syncDir(filepath.Dir(path)); err != nil {
			f.Close()
			return nil, err
		}
	}
	raw, err := io.ReadAll(f)
	if err != nil {
		f.Close()
		return nil, err
	}

	// Pedaço final incompleto: queda de energia no meio de uma escrita. Ele nunca foi confirmado, então sai
	if extra := len(raw) % BlockSize; extra != 0 {
		raw = raw[:len(raw)-extra]
		if err := truncateSync(f, int64(len(raw))); err != nil {
			f.Close()
			return nil, err
		}
		log.Warn("dropped an incomplete block at the end of the chain", "bytes", extra, "path", path)
	}

	blocks, err := ParseChain(raw)
	if err != nil {
		f.Close()
		return nil, err
	}

	// Na partida vale só a validade da cadeia, nunca a regra do relógio: com o relógio da placa atrasado, os blocos
	// gravados estariam "no futuro" e o validator recusaria o próprio histórico
	if verr, idx := VerifyChain(blocks); verr != None {
		// Um bloco inteiro inválido não é queda de energia: é dano ou adulteração. O prefixo válido continua; o resto
		// vai para um arquivo ao lado, sem apagar nada
		q := fmt.Sprintf("%s.quarantine-%d", path, clock().UnixNano())
		if err := os.WriteFile(q, raw[idx*BlockSize:], 0o644); err != nil {
			f.Close()
			return nil, err
		}
		if err := syncDir(filepath.Dir(path)); err != nil {
			f.Close()
			return nil, err
		}
		if err := truncateSync(f, int64(idx*BlockSize)); err != nil {
			f.Close()
			return nil, err
		}
		log.Error("invalid block in the stored chain; kept the valid prefix and moved the rest aside",
			"error", verr.String(), "block", idx, "kept", idx, "moved", len(blocks)-idx, "quarantine", q)
		blocks = blocks[:idx]
	}

	c := &Chain{blocks: blocks, file: f, clock: clock}
	c.initClock()
	return c, nil
}

func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

func truncateSync(f *os.File, size int64) error {
	if err := f.Truncate(size); err != nil {
		return err
	}
	return f.Sync()
}

// Close fecha o arquivo da cadeia
func (c *Chain) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.file == nil {
		return nil
	}
	err := c.file.Close()
	c.file = nil
	return err
}

// initClock fixa a base do relógio efetivo. Chamado com c.mu travado, ou antes de a cadeia ser compartilhada
func (c *Chain) initClock() {
	if c.clock == nil {
		c.clock = time.Now
	}
	c.start = c.clock()
	c.base = c.start.UnixNano()
	if n := len(c.blocks); n > 0 && c.blocks[n-1].Stamp > c.base {
		c.base = c.blocks[n-1].Stamp
	}
}

// now devolve o relógio efetivo. Chamado com c.mu travado
func (c *Chain) now() Timestamp {
	if c.start.IsZero() {
		c.initClock()
	}
	return c.base + int64(c.clock().Sub(c.start))
}

// Now devolve o relógio efetivo do validator, em ns desde 1970: é a hora que o navegador usa para assinar
func (c *Chain) Now() Timestamp {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now()
}

// RunStart devolve o relógio efetivo no início desta execução (ver RunStartHeader)
func (c *Chain) RunStart() Timestamp {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.start.IsZero() {
		c.initClock()
	}
	return c.base
}

// Append confere b contra a cabeça e contra o relógio efetivo e, se aceito, grava e acrescenta. Devolve None se
// aceitou; a cabeça atual, se recusou por causa dela; e ErrStorage se o bloco era válido mas não foi gravado
//
// Gênese: com a cadeia vazia, aceita-se um bloco válido com prev zerado. Quem envia o primeiro bloco define a sala
func (c *Chain) Append(b Block) (ValidationError, *Block, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	var head *Block
	if len(c.blocks) == 0 {
		if b.Prev != (Signature{}) {
			return NoHashContinuity, nil, nil
		}
		if err := b.Verify(); err != None {
			return err, nil, nil
		}
		if err := VerifyGenesisWork(&b); err != None {
			return err, nil, nil
		}
	} else {
		h := c.blocks[len(c.blocks)-1]
		head = &h
		// As mesmas regras do ChainVerify, testado contra o vetor: assinatura, sala, carimbo, prev e o trabalho que o
		// gênese pede
		if err := b.Verify(); err != None {
			return err, head, nil
		}
		if err := VerifyLink(&h, &b, c.blocks[0].Info); err != None {
			return err, head, nil
		}
	}
	if b.Stamp > c.now()+int64(MaxFutureSkew) {
		return TimestampInFuture, head, nil
	}

	if c.file != nil {
		size := int64(len(c.blocks)) * BlockSize
		_, err := c.file.Write(b.MarshalBinary())
		if err == nil {
			err = c.file.Sync()
		}
		if err != nil {
			// Desfaz um pedaço que tenha ficado no arquivo; a memória não foi tocada
			_ = truncateSync(c.file, size)
			return None, head, fmt.Errorf("%w: %v", ErrStorage, err)
		}
	}
	c.blocks = append(c.blocks, b)
	return None, nil, nil
}

// Bytes devolve a cadeia inteira, blocos de 512 bytes concatenados
func (c *Chain) Bytes() []byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]byte, 0, len(c.blocks)*BlockSize)
	for i := range c.blocks {
		out = append(out, c.blocks[i].MarshalBinary()...)
	}
	return out
}

// Len devolve o número de blocos
func (c *Chain) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.blocks)
}

// ValidatorHandler expõe a API interna descrita em docs/protocol.md
func ValidatorHandler(c *Chain, log *slog.Logger) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "ok\n")
	})

	mux.HandleFunc("GET /chain", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set(NowHeader, strconv.FormatInt(c.Now(), 10))
		w.Header().Set(RunStartHeader, strconv.FormatInt(c.RunStart(), 10))
		_, _ = w.Write(c.Bytes())
	})

	mux.HandleFunc("POST /blocks", func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, BlockSize))
		var tooBig *http.MaxBytesError
		switch {
		case errors.As(err, &tooBig):
			reject(w, http.StatusRequestEntityTooLarge, "INVALID_SIZE", nil)
			return
		case err != nil:
			reject(w, http.StatusBadRequest, "READ_ERROR", nil)
			return
		case len(body) != BlockSize:
			reject(w, http.StatusBadRequest, "INVALID_SIZE", nil)
			return
		}
		var b Block
		if err := b.UnmarshalBinary(body); err != nil {
			reject(w, http.StatusBadRequest, "INVALID_SIZE", nil)
			return
		}
		verr, head, err := c.Append(b)
		if err != nil {
			log.Error("block not stored", "err", err, "author", hex.EncodeToString(b.Author[:4]))
			reject(w, http.StatusInternalServerError, "STORAGE_ERROR", head)
			return
		}
		if verr != None {
			log.Info("block rejected", "error", verr.String(), "author", hex.EncodeToString(b.Author[:4]))
			reject(w, http.StatusConflict, verr.String(), head)
			return
		}
		log.Info("block accepted", "height", c.Len(), "author", hex.EncodeToString(b.Author[:4]))
		w.WriteHeader(http.StatusOK)
	})

	return mux
}

func reject(w http.ResponseWriter, status int, code string, head *Block) {
	rej := Rejection{Error: code}
	if head != nil {
		rej.Head = hex.EncodeToString(head.MarshalBinary())
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(rej)
}

// ParseChain lê blocos de 512 bytes concatenados (o formato do GET /chain e do arquivo gravado)
func ParseChain(raw []byte) ([]Block, error) {
	if len(raw)%BlockSize != 0 {
		return nil, fmt.Errorf("file has %d bytes, not a multiple of %d", len(raw), BlockSize)
	}
	chain := make([]Block, len(raw)/BlockSize)
	for i := range chain {
		if err := chain[i].UnmarshalBinary(raw[i*BlockSize : (i+1)*BlockSize]); err != nil {
			return nil, err
		}
	}
	return chain, nil
}

// VerifyChain aplica as mesmas regras do POST /blocks a uma cadeia inteira: gênese com prev zerado e ChainVerify no
// resto. Devolve (None, -1) se válida. Não aplica a regra do relógio, que só vale na hora de aceitar um bloco novo
func VerifyChain(chain []Block) (ValidationError, int) {
	if len(chain) > 0 && chain[0].Prev != (Signature{}) {
		return NoHashContinuity, 0
	}
	return ChainVerify(chain)
}

// FingerprintSize é quantos bytes da assinatura entram na impressão digital: 8 bytes, 16 dígitos hex, curtos o bastante
// para duas pessoas compararem na tela
const FingerprintSize = 8

// Fingerprint devolve a impressão digital da cadeia na altura height (número de blocos, de 1 a len(chain)): os
// primeiros FingerprintSize bytes da assinatura do bloco height-1, em hex. A assinatura de cada bloco cobre o prev, que
// é a assinatura do anterior, então ela compromete todo o histórico até ali: duas cadeias com a mesma impressão digital
// na mesma altura têm os mesmos blocos até essa altura. Só faz sentido para uma cadeia válida (VerifyChain)
func Fingerprint(chain []Block, height int) (string, error) {
	if height < 1 || height > len(chain) {
		return "", fmt.Errorf("bizas: height %d out of range 1..%d", height, len(chain))
	}
	sig := chain[height-1].Sig
	return hex.EncodeToString(sig[:FingerprintSize]), nil
}
