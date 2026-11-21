package bizas

import "time"

// Timestamp é o número de nanossegundos desde 1970-01-01 UTC
type Timestamp = int64

// GetTimestamp devolve o instante atual
func GetTimestamp() Timestamp {
	return time.Now().UnixNano()
}

// IsTimestampValid diz se o carimbo é uma data válida. Todo int64 em nanossegundos é uma data representável, então a
// função sempre devolve true. Carimbos no futuro são recusados pelo validator (TimestampInFuture), não aqui
func IsTimestampValid(ts Timestamp) bool {
	_ = ts
	return true
}

// TimestampToTime converte para time.Time no fuso UTC
func TimestampToTime(ts Timestamp) time.Time {
	return time.Unix(0, ts).UTC()
}

// TimestampToString formata em RFC 3339 com nanossegundos (sem zeros à direita), com a hora convertida para o fuso dado
// em minutos em relação ao UTC
func TimestampToString(ts Timestamp, offsetMinutes int) string {
	t := TimestampToTime(ts)
	if offsetMinutes != 0 {
		t = t.In(time.FixedZone("", offsetMinutes*60))
	}
	return t.Format(time.RFC3339Nano)
}
