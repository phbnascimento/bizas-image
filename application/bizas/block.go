// O que se assina são os 512 bytes do bloco, em little-endian e no layout fixo abaixo, com o campo sig zerado. O campo
// prev guarda a assinatura do bloco anterior: é ela que encadeia a cadeia
//
//	offset  tam  campo
//	     0    8  room
//	     8    8  stamp  (int64, ns desde 1970 UTC)
//	    16    8  nonce  (uint64)
//	    24    4  info   (uint32)
//	    28    2  type   (uint16)
//	    30    2  length (int16)
//	    32   32  author (chave pública Ed25519)
//	    64   64  sig
//	   128   64  prev
//	   192  320  data
package bizas

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"math/bits"
)

const (
	MaxDataLength = 320
	BlockSize     = 512
	// MaxWorkBits é o maior N que um gênese pode pedir no info. Cada bit a mais dobra o número médio de assinaturas
	// que cada mensagem custa; um N alto demais deixaria a sala inutilizável para todos
	MaxWorkBits = 20

	offRoom   = 0
	offStamp  = 8
	offNonce  = 16
	offInfo   = 24
	offType   = 28
	offLength = 30
	offAuthor = 32
	offSig    = 64
	offPrev   = 128
	offData   = 192
)

type (
	Seed       [ed25519.SeedSize]byte
	PrivateKey = ed25519.PrivateKey
	PublicKey  [ed25519.PublicKeySize]byte
	Signature  [ed25519.SignatureSize]byte
	Data       [MaxDataLength]byte
	Room       [8]byte
)

// AddressBook associa uma chave pública a um apelido
type AddressBook map[PublicKey]string

// DefaultRoomName é "Bizas" seguido de zeros
var DefaultRoomName = Room{'B', 'i', 'z', 'a', 's'}

type AuthProof struct {
	Author PublicKey
	Sig    Signature
}

type DataType uint16

// Os valores 1 a 4 não são usados e ficam reservados
const (
	Text          DataType = 0
	NetworkAction DataType = 5
	Other         DataType = 6
	// Poll e Vote são a extensão de enquetes (poll.go)
	Poll DataType = 7
	Vote DataType = 8
)

var dataTypeNames = map[DataType]string{Text: "TEXT", NetworkAction: "NETWORK_ACTION", Other: "OTHER", Poll: "POLL",
	Vote: "VOTE"}

func (t DataType) String() string {
	if name, ok := dataTypeNames[t]; ok {
		return name
	}
	return fmt.Sprintf("DataType(%d)", uint16(t))
}

type Metadata struct {
	Room   Room
	Stamp  Timestamp
	Nonce  uint64
	Info   uint32
	Type   DataType
	Length int16
}

type Block struct {
	Metadata
	AuthProof
	Prev Signature
	Data Data
}

type ValidationError int

const (
	None ValidationError = iota
	Fraud
	CorruptedTimestamp
	InvalidRoom
	InvalidLength
	NoTimestampContinuity
	NoHashContinuity
	// TimestampInFuture é regra do validator (relógio da placa), não do bloco isolado: Verify e ChainVerify não a usam
	TimestampInFuture
	// InsufficientWork: a assinatura não começa com os N bits zero que o gênese pede
	InsufficientWork
	// InvalidWorkBits: o gênese pede mais que MaxWorkBits bits zero
	InvalidWorkBits
	// Extensão de enquetes (poll.go). InvalidPoll: enquete malformada, ou no gênese
	InvalidPoll
	// InvalidVote: voto malformado, numa enquete que não existe, numa opção que não existe, ou retirada sem voto
	InvalidVote
	// DuplicateVote: a pessoa já tem voto ativo nessa opção, ou, numa enquete exclusiva, em outra
	DuplicateVote
)

var validationErrorNames = [...]string{"NONE", "FRAUD", "CORRUPTED_TIMESTAMP", "INVALID_ROOM", "INVALID_LENGTH",
	"NO_TIMESTAMP_CONTINUITY", "NO_HASH_CONTINUITY", "TIMESTAMP_IN_FUTURE", "INSUFFICIENT_WORK", "INVALID_WORK_BITS",
	"INVALID_POLL", "INVALID_VOTE", "DUPLICATE_VOTE"}

func (e ValidationError) String() string {
	if e >= 0 && int(e) < len(validationErrorNames) {
		return validationErrorNames[e]
	}
	return fmt.Sprintf("ValidationError(%d)", int(e))
}

// ErrDataTooLong é devolvido quando o conteúdo não cabe em Data
var ErrDataTooLong = errors.New("bizas: content larger than MaxDataLength")

// MarshalBinary devolve os 512 bytes do bloco no layout descrito no pacote
func (b *Block) MarshalBinary() []byte {
	out := make([]byte, BlockSize)
	le := binary.LittleEndian
	copy(out[offRoom:], b.Room[:])
	le.PutUint64(out[offStamp:], uint64(b.Stamp))
	le.PutUint64(out[offNonce:], b.Nonce)
	le.PutUint32(out[offInfo:], b.Info)
	le.PutUint16(out[offType:], uint16(b.Type))
	le.PutUint16(out[offLength:], uint16(b.Length))
	copy(out[offAuthor:], b.Author[:])
	copy(out[offSig:], b.Sig[:])
	copy(out[offPrev:], b.Prev[:])
	copy(out[offData:], b.Data[:])
	return out
}

// UnmarshalBinary lê um bloco de exatamente BlockSize bytes
func (b *Block) UnmarshalBinary(in []byte) error {
	if len(in) != BlockSize {
		return fmt.Errorf("bizas: block has %d bytes, want %d", len(in), BlockSize)
	}
	le := binary.LittleEndian
	copy(b.Room[:], in[offRoom:])
	b.Stamp = Timestamp(le.Uint64(in[offStamp:]))
	b.Nonce = le.Uint64(in[offNonce:])
	b.Info = le.Uint32(in[offInfo:])
	b.Type = DataType(le.Uint16(in[offType:]))
	b.Length = int16(le.Uint16(in[offLength:]))
	copy(b.Author[:], in[offAuthor:])
	copy(b.Sig[:], in[offSig:])
	copy(b.Prev[:], in[offPrev:])
	copy(b.Data[:], in[offData:])
	return nil
}

// GetRandomSeed sorteia uma seed com crypto/rand
func GetRandomSeed() (seed Seed, err error) {
	_, err = rand.Read(seed[:])
	return
}

// SeedClear zera a seed. Em Go não há garantia de que não reste cópia em outro lugar da memória (pilha, coletor de
// lixo)
func SeedClear(seed *Seed) {
	clear(seed[:])
}

// GetPrivKey deriva a chave privada a partir de uma seed de 32 bytes
func GetPrivKey(seed []byte) (PrivateKey, error) {
	if len(seed) != ed25519.SeedSize {
		return nil, fmt.Errorf("bizas: seed has %d bytes, want %d", len(seed), ed25519.SeedSize)
	}
	return ed25519.NewKeyFromSeed(seed), nil
}

// PrivKeyDerivePubKey devolve a chave pública de uma chave privada
func PrivKeyDerivePubKey(key PrivateKey) (pub PublicKey) {
	copy(pub[:], key.Public().(ed25519.PublicKey))
	return
}

// NextBlock prepara o bloco seguinte ao último da cadeia: mesma sala, prev apontando para a assinatura do último e o
// carimbo de tempo atual. Entra em pânico se a cadeia estiver vazia
func NextBlock(chain []Block) (block Block) {
	if len(chain) == 0 {
		panic("bizas: NextBlock on an empty chain")
	}
	last := &chain[len(chain)-1]
	block.Room = last.Room
	block.Prev = last.Sig
	block.Stamp = GetTimestamp()
	return
}

// Sign preenche Author e assina o bloco com Sig zerado
func (b *Block) Sign(key PrivateKey) {
	b.Author = PrivKeyDerivePubKey(key)
	b.Sig = Signature{} // garante que nenhuma assinatura prévia entre no que é assinado
	copy(b.Sig[:], ed25519.Sign(key, b.MarshalBinary()))
}

// HasWork diz se a assinatura começa com pelo menos workBits bits zero (do bit mais alto do primeiro byte em diante)
func (b *Block) HasWork(workBits uint32) bool {
	return uint32(CountLeadingZeroBits(b.Sig[:])) >= workBits
}

// Mine assina o bloco variando o nonce, a partir do valor atual e de um em um, até a assinatura começar com workBits
// bits zero. A assinatura Ed25519 é determinística: o nonce é o único campo que muda a cada tentativa
func (b *Block) Mine(key PrivateKey, workBits uint32) {
	for {
		b.Sign(key)
		if b.HasWork(workBits) {
			return
		}
		b.Nonce++
	}
}

// SplitSignature devolve uma cópia do bloco com Sig zerado e a assinatura
func (b Block) SplitSignature() (unsigned Block, sig Signature) {
	unsigned = b
	unsigned.Sig = Signature{}
	return unsigned, b.Sig
}

// Verify confere tamanho, carimbo de tempo e assinatura de um bloco isolado
func (b Block) Verify() ValidationError {
	// length é int16: negativo também é inválido
	if b.Length < 0 || b.Length > MaxDataLength {
		return InvalidLength
	}
	if !IsTimestampValid(b.Stamp) {
		return CorruptedTimestamp
	}
	unsigned, sig := b.SplitSignature()
	if !ed25519.Verify(b.Author[:], unsigned.MarshalBinary(), sig[:]) {
		return Fraud
	}
	return None
}

// ChainVerify confere cada bloco e o encadeamento com o anterior. O info do gênese é o N da cadeia: a assinatura de
// todo bloco, inclusive a do gênese, tem de começar com N bits zero. As enquetes e os votos são conferidos contra o
// estado da cadeia até ali (Tally). Devolve o primeiro erro e o índice do bloco, ou (None, -1)
func ChainVerify(chain []Block) (ValidationError, int) {
	tally := NewTally()
	for i := range chain {
		block := &chain[i]
		if err := block.Verify(); err != None {
			return err, i
		}
		if i == 0 {
			if err := VerifyGenesisWork(block); err != None {
				return err, i
			}
		} else if err := VerifyLink(&chain[i-1], block, chain[0].Info); err != None {
			return err, i
		}
		if err := tally.Check(i, block); err != None {
			return err, i
		}
		tally.Apply(i, block)
	}
	return None, -1
}

// VerifyGenesisWork confere o N que o gênese pede no info (até MaxWorkBits) e a assinatura dele contra esse N
func VerifyGenesisWork(genesis *Block) ValidationError {
	if genesis.Info > MaxWorkBits {
		return InvalidWorkBits
	}
	if !genesis.HasWork(genesis.Info) {
		return InsufficientWork
	}
	return None
}

// VerifyLink confere um bloco contra o anterior numa cadeia que pede workBits bits zero: sala, carimbo, prev e
// trabalho. O bloco já tem de ter passado por Verify
func VerifyLink(last, block *Block, workBits uint32) ValidationError {
	if block.Room != last.Room {
		return InvalidRoom
	}
	if block.Stamp < last.Stamp {
		return NoTimestampContinuity
	}
	if block.Prev != last.Sig {
		return NoHashContinuity
	}
	if !block.HasWork(workBits) {
		return InsufficientWork
	}
	return None
}

// UploadString grava um texto em Data com tipo Text
func (b *Block) UploadString(msg string) error {
	return b.UploadBytes([]byte(msg), Text)
}

// UploadBytes grava bytes em Data. Recusa conteúdo maior que MaxDataLength em vez de truncar, e zera o resto de Data
func (b *Block) UploadBytes(data []byte, t DataType) error {
	if len(data) > MaxDataLength {
		return ErrDataTooLong
	}
	b.Data = Data{}
	copy(b.Data[:], data)
	b.Length = int16(len(data))
	b.Type = t
	return nil
}

// UploadValue grava um valor de tamanho fixo (ou fatia de valores) em little-endian
func (b *Block) UploadValue(v any, t DataType) error {
	var buf bytes.Buffer
	if err := binary.Write(&buf, binary.LittleEndian, v); err != nil {
		return err
	}
	return b.UploadBytes(buf.Bytes(), t)
}

// CountLeadingZeroBits conta os bits zero à esquerda de data
func CountLeadingZeroBits(data []byte) (zeros int) {
	for _, x := range data {
		if x != 0 {
			return zeros + bits.LeadingZeros8(x)
		}
		zeros += 8
	}
	return zeros
}
