// Enquetes (POLL e VOTE): uma extensão que usa só os campos livres do bloco, type e info. O formato do bloco, a
// assinatura e o encadeamento não mudam; mudam só as cadeias que são válidas, então a extensão é um soft fork: toda
// cadeia válida com estas regras também é válida sem elas
//
//	POLL  info: bit 0 = opções mutuamente exclusivas (os outros bits zero)
//	      data: pergunta e opções em UTF-8, separadas por um byte 0: "pergunta\x00opção 1\x00opção 2"
//	VOTE  info: índice (a partir de 0) do bloco da enquete
//	      data: 2 bytes, o índice da opção e a ação (1 vota, 0 retira o voto)
//
// As regras dependem do estado da cadeia (quem já votou em quê), por isso ficam no Tally, que ChainVerify e
// Chain.Append alimentam bloco a bloco
package bizas

import (
	"bytes"
	"unicode/utf8"
)

const (
	// PollExclusive no info de uma enquete: cada pessoa tem no máximo um voto ativo nela
	PollExclusive  uint32 = 1
	MinPollOptions        = 2
	MaxPollOptions        = 10
	// VoteSize é o tamanho de data num VOTE: opção e ação
	VoteSize = 2
	// Ações de um VOTE
	VoteRevoke byte = 0
	VoteCast   byte = 1
)

// PollContent é o conteúdo de um bloco POLL
type PollContent struct {
	Question  string
	Options   []string
	Exclusive bool
}

// ParsePoll lê um bloco POLL. ok é false se o tipo não é POLL ou o conteúdo não segue o formato: UTF-8 válido, pergunta
// e opções não vazias, de MinPollOptions a MaxPollOptions opções, nenhuma repetida (byte a byte), e só o bit
// PollExclusive no info
func ParsePoll(b *Block) (p PollContent, ok bool) {
	if b.Type != Poll || b.Info&^PollExclusive != 0 || b.Length < 0 || b.Length > MaxDataLength {
		return p, false
	}
	data := b.Data[:b.Length]
	if !utf8.Valid(data) {
		return p, false
	}
	parts := bytes.Split(data, []byte{0})
	if len(parts) < 1+MinPollOptions || len(parts) > 1+MaxPollOptions {
		return p, false
	}
	for i, part := range parts {
		if len(part) == 0 {
			return p, false
		}
		// Opções repetidas: compara com as anteriores (a pergunta, parts[0], fica de fora)
		for j := 1; i > 1 && j < i; j++ {
			if bytes.Equal(parts[j], part) {
				return p, false
			}
		}
	}
	p.Question = string(parts[0])
	for _, o := range parts[1:] {
		p.Options = append(p.Options, string(o))
	}
	p.Exclusive = b.Info&PollExclusive != 0
	return p, true
}

// UploadPoll grava uma enquete no bloco: tipo POLL, o info com a flag e o data no formato de ParsePoll. Não confere as
// regras de conteúdo (o validator confere); recusa só o que não cabe em Data
func (b *Block) UploadPoll(question string, options []string, exclusive bool) error {
	data := []byte(question)
	for _, o := range options {
		data = append(data, 0)
		data = append(data, o...)
	}
	if err := b.UploadBytes(data, Poll); err != nil {
		return err
	}
	b.Info = 0
	if exclusive {
		b.Info = PollExclusive
	}
	return nil
}

// UploadVote grava um voto (cast) ou a retirada de um voto (!cast) na opção option da enquete do bloco poll
func (b *Block) UploadVote(poll uint32, option byte, cast bool) {
	action := VoteRevoke
	if cast {
		action = VoteCast
	}
	_ = b.UploadBytes([]byte{option, action}, Vote) // 2 bytes sempre cabem
	b.Info = poll
}

type pollState struct {
	options   int
	exclusive bool
	votes     map[PublicKey]map[byte]bool // votos ativos de cada pessoa
}

// Tally guarda as enquetes de uma cadeia e os votos ativos. Check confere um bloco contra esse estado sem mudá-lo;
// Apply registra um bloco que já passou por Check (e, no validator, que já foi gravado)
type Tally struct {
	polls map[uint32]*pollState
}

func NewTally() *Tally {
	return &Tally{polls: map[uint32]*pollState{}}
}

// Check confere o bloco de índice index (a partir de 0) contra as enquetes anteriores. Blocos de outros tipos passam
func (t *Tally) Check(index int, b *Block) ValidationError {
	switch b.Type {
	case Poll:
		// O info do gênese é o N da prova de trabalho; ele não pode ser também a flag de uma enquete
		if index == 0 {
			return InvalidPoll
		}
		if _, ok := ParsePoll(b); !ok {
			return InvalidPoll
		}
	case Vote:
		if b.Length != VoteSize || b.Data[1] > VoteCast {
			return InvalidVote
		}
		p := t.polls[b.Info]
		option := b.Data[0]
		if p == nil || int(option) >= p.options {
			return InvalidVote
		}
		mine := p.votes[b.Author]
		if b.Data[1] == VoteRevoke {
			if !mine[option] {
				return InvalidVote
			}
			return None
		}
		if mine[option] || (p.exclusive && len(mine) > 0) {
			return DuplicateVote
		}
	}
	return None
}

// Apply registra um bloco aceito. Só deve ser chamado depois de Check devolver None
func (t *Tally) Apply(index int, b *Block) {
	switch b.Type {
	case Poll:
		p, _ := ParsePoll(b)
		t.polls[uint32(index)] = &pollState{options: len(p.Options), exclusive: p.Exclusive,
			votes: map[PublicKey]map[byte]bool{}}
	case Vote:
		p := t.polls[b.Info]
		option := b.Data[0]
		if b.Data[1] == VoteRevoke {
			delete(p.votes[b.Author], option)
			if len(p.votes[b.Author]) == 0 {
				delete(p.votes, b.Author)
			}
			return
		}
		if p.votes[b.Author] == nil {
			p.votes[b.Author] = map[byte]bool{}
		}
		p.votes[b.Author][option] = true
	}
}

// Counts devolve quantos votos ativos cada opção da enquete do bloco poll tem, ou nil se ele não é uma enquete
func (t *Tally) Counts(poll uint32) []int {
	p := t.polls[poll]
	if p == nil {
		return nil
	}
	counts := make([]int, p.options)
	for _, mine := range p.votes {
		for o := range mine {
			counts[o]++
		}
	}
	return counts
}
