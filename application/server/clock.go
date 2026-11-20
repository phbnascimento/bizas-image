// Hora real para a exibição: o set-date (informada à mão) e o set-auto-date (consultada na rede por SNTP). Nenhum dos
// dois mexe no relógio da placa nem nos carimbos assinados: só calibram a exibição (ver AdminHandler)

package main

import (
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"strings"
	"time"
)

// DateLayout é o formato do set-date: ano até os segundos, separados por hífen
const DateLayout = "2006-01-02-15-04-05"

// DefaultZone é o fuso da hora digitada no set-date quando a flag --tz não é usada: UTC (Greenwich)
const DefaultZone = "Z"

// ParseSetDateArgs lê os argumentos do set-date: uma data e, opcionalmente, --tz ZONA (ou --tz=ZONA), em qualquer ordem
func ParseSetDateArgs(args []string) (value, zone string, err error) {
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--tz":
			if i+1 >= len(args) {
				return "", "", fmt.Errorf("--tz needs a time zone, like --tz -03:00")
			}
			i++
			zone = args[i]
		case strings.HasPrefix(a, "--tz="):
			zone = strings.TrimPrefix(a, "--tz=")
		case strings.HasPrefix(a, "--"):
			return "", "", fmt.Errorf("unknown flag %q", a)
		case value != "":
			return "", "", fmt.Errorf("only one date is accepted (got %q and %q)", value, a)
		default:
			value = a
		}
	}
	if value == "" {
		return "", "", fmt.Errorf("missing the date")
	}
	return value, zone, nil
}

// ParseSetDate lê "AAAA-MM-DD-hh-mm-ss" no fuso zone ("-03:00", "+00:00" ou "Z"; vazio é DefaultZone)
func ParseSetDate(value, zone string) (time.Time, error) {
	if zone == "" {
		zone = DefaultZone
	}
	loc, err := parseZone(zone)
	if err != nil {
		return time.Time{}, err
	}
	t, err := time.ParseInLocation(DateLayout, value, loc)
	if err != nil {
		return time.Time{}, fmt.Errorf("date must be YYYY-MM-DD-hh-mm-ss, for example 2026-11-20-00-39-55 (got %q)", value)
	}
	return t, nil
}

func parseZone(zone string) (*time.Location, error) {
	if zone == "Z" {
		return time.UTC, nil
	}
	t, err := time.Parse("-07:00", zone)
	if err != nil {
		return nil, fmt.Errorf("time zone must be like -03:00, +00:00 or Z (got %q)", zone)
	}
	_, off := t.Zone()
	return time.FixedZone(zone, off), nil
}

// NTPServers são consultados em ordem pelo set-auto-date
var NTPServers = []string{"pool.ntp.org", "time.google.com", "time.cloudflare.com"}

// ntpEpochOffset é a diferença, em segundos, entre a época do NTP (1900) e a do Unix (1970)
const ntpEpochOffset = 2208988800

// QuerySNTP pede a hora a um servidor NTP (RFC 4330, modo cliente) e devolve o carimbo de transmissão dele, corrigido
// pela metade do tempo de ida e volta
func QuerySNTP(addr string, timeout time.Duration) (time.Time, error) {
	conn, err := net.DialTimeout("udp", addr, timeout)
	if err != nil {
		return time.Time{}, err
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(timeout)); err != nil {
		return time.Time{}, err
	}
	req := make([]byte, 48)
	req[0] = 0x23 // LI 0, versão 4, modo 3 (cliente)
	sent := time.Now()
	if _, err := conn.Write(req); err != nil {
		return time.Time{}, err
	}
	resp := make([]byte, 48)
	n, err := conn.Read(resp)
	if err != nil {
		return time.Time{}, err
	}
	rtt := time.Since(sent)
	if n < 48 {
		return time.Time{}, fmt.Errorf("short NTP reply (%d bytes)", n)
	}
	if mode := resp[0] & 0x07; mode != 4 {
		return time.Time{}, fmt.Errorf("NTP reply is not from a server (mode %d)", mode)
	}
	if stratum := resp[1]; stratum == 0 || stratum > 15 {
		return time.Time{}, fmt.Errorf("NTP server is not synchronized (stratum %d)", stratum)
	}
	sec := binary.BigEndian.Uint32(resp[40:44])
	frac := binary.BigEndian.Uint32(resp[44:48])
	if sec == 0 {
		return time.Time{}, errors.New("NTP reply has no transmit time")
	}
	nsec := (int64(frac) * 1e9) >> 32
	t := time.Unix(int64(sec)-ntpEpochOffset, nsec)
	return t.Add(rtt / 2), nil
}

// AutoDate tenta os servidores em ordem e devolve a primeira hora obtida, ou um erro que lista cada falha
func AutoDate(servers []string, timeout time.Duration) (time.Time, error) {
	var fails []string
	for _, s := range servers {
		t, err := QuerySNTP(net.JoinHostPort(s, "123"), timeout)
		if err == nil {
			return t, nil
		}
		fails = append(fails, fmt.Sprintf("%s: %v", s, err))
	}
	return time.Time{}, fmt.Errorf("could not get the time from the network; is the board connected (Ethernet or Wi-Fi)? "+
		"Use set-date YYYY-MM-DD-hh-mm-ss instead.\n  %s", strings.Join(fails, "\n  "))
}
