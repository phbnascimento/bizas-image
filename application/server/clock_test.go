package main

import (
	"encoding/binary"
	"net"
	"strings"
	"testing"
	"time"
)

func TestParseSetDate(t *testing.T) {
	cases := []struct {
		value, zone string
		want        time.Time
	}{
		{"2026-11-20-00-39-55", "", time.Date(2026, 11, 20, 0, 39, 55, 0, time.UTC)}, // UTC por padrão
		{"2026-11-20-00-39-55", "-03:00", time.Date(2026, 11, 20, 3, 39, 55, 0, time.UTC)},
		{"2026-11-20-00-39-55", "Z", time.Date(2026, 11, 20, 0, 39, 55, 0, time.UTC)},
		{"2026-11-20-00-39-55", "+05:30", time.Date(2026, 11, 19, 19, 9, 55, 0, time.UTC)},
	}
	for _, c := range cases {
		got, err := ParseSetDate(c.value, c.zone)
		if err != nil || !got.Equal(c.want) {
			t.Errorf("ParseSetDate(%q, %q) = %v, %v; want %v", c.value, c.zone, got.UTC(), err, c.want)
		}
	}
	for _, bad := range [][2]string{{"2026-11-20 00:39:55", ""}, {"2026-13-01-00-00-00", ""}, {"2026-11-20-00-39", ""},
		{"2026-11-20-00-39-55", "-3"}, {"2026-11-20-00-39-55", "BRT"}} {
		if _, err := ParseSetDate(bad[0], bad[1]); err == nil {
			t.Errorf("ParseSetDate(%q, %q) accepted", bad[0], bad[1])
		}
	}
}

// fakeNTP responde a cada pedido com reply(pedido); devolve o endereço e uma função para encerrar
func fakeNTP(t *testing.T, reply func(req []byte) []byte) string {
	t.Helper()
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pc.Close() })
	go func() {
		buf := make([]byte, 64)
		for {
			n, addr, err := pc.ReadFrom(buf)
			if err != nil {
				return
			}
			if r := reply(buf[:n]); r != nil {
				pc.WriteTo(r, addr)
			}
		}
	}()
	return pc.LocalAddr().String()
}

func ntpReply(mode, stratum byte, at time.Time) []byte {
	r := make([]byte, 48)
	r[0] = 0x20 | mode // versão 4
	r[1] = stratum
	binary.BigEndian.PutUint32(r[40:], uint32(at.Unix()+ntpEpochOffset))
	binary.BigEndian.PutUint32(r[44:], uint32((int64(at.Nanosecond())<<32)/1e9))
	return r
}

func TestQuerySNTP(t *testing.T) {
	want := time.Date(2026, 11, 20, 3, 39, 55, 500_000_000, time.UTC)
	addr := fakeNTP(t, func(req []byte) []byte {
		if len(req) != 48 || req[0]&0x07 != 3 {
			return nil // só responde a pedido de cliente bem formado
		}
		return ntpReply(4, 2, want)
	})
	got, err := QuerySNTP(addr, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if d := got.Sub(want); d < 0 || d > 100*time.Millisecond {
		t.Fatalf("got %v, want %v (+ half the round trip)", got.UTC(), want)
	}
}

func TestQuerySNTPBadReplies(t *testing.T) {
	now := time.Now()
	cases := map[string]func([]byte) []byte{
		"client mode":    func([]byte) []byte { return ntpReply(3, 2, now) },
		"unsynchronized": func([]byte) []byte { return ntpReply(4, 0, now) },
		"short reply":    func([]byte) []byte { return []byte{0x24, 2} },
		"no reply":       func([]byte) []byte { return nil },
	}
	for name, reply := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := QuerySNTP(fakeNTP(t, reply), 300*time.Millisecond); err == nil {
				t.Fatal("accepted")
			}
		})
	}
}

func TestAutoDateNoNetworkMessage(t *testing.T) {
	silent := fakeNTP(t, func([]byte) []byte { return nil })
	host, port, _ := net.SplitHostPort(silent)
	if port == "123" {
		t.Skip("unexpected port")
	}
	// Endereços sem servidor: os dois falham, e a mensagem diz o que fazer
	_, err := AutoDate([]string{host + ".invalid", "127.0.0.1"}, 300*time.Millisecond)
	if err == nil || !strings.Contains(err.Error(), "could not get the time from the network") ||
		!strings.Contains(err.Error(), "set-date") {
		t.Fatalf("err = %v", err)
	}
}

func TestParseSetDateArgs(t *testing.T) {
	ok := []struct {
		args        []string
		value, zone string
	}{
		{[]string{"2026-11-20-00-39-55"}, "2026-11-20-00-39-55", ""},
		{[]string{"--tz", "-03:00", "2026-11-20-00-39-55"}, "2026-11-20-00-39-55", "-03:00"},
		{[]string{"2026-11-20-00-39-55", "--tz", "-03:00"}, "2026-11-20-00-39-55", "-03:00"},
		{[]string{"--tz=+05:30", "2026-11-20-00-39-55"}, "2026-11-20-00-39-55", "+05:30"},
	}
	for _, c := range ok {
		v, z, err := ParseSetDateArgs(c.args)
		if err != nil || v != c.value || z != c.zone {
			t.Errorf("ParseSetDateArgs(%q) = %q, %q, %v", c.args, v, z, err)
		}
	}
	for _, bad := range [][]string{{}, {"--tz"}, {"--tz", "-03:00"}, {"a", "b"}, {"--zone", "Z", "2026-11-20-00-39-55"}} {
		if _, _, err := ParseSetDateArgs(bad); err == nil {
			t.Errorf("ParseSetDateArgs(%q) accepted", bad)
		}
	}
}
