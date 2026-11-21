package venues

import (
	"testing"
	"time"

	"music/profile"
)

func TestOpenAt(t *testing.T) {
	h := Hours{"fri": {"18:00-02:00"}, "sat": {"12:00-15:00", "17:00-24:00"}}
	at := func(day, hm string) time.Time {
		// 2026-11-20 — пятница.
		d := map[string]int{"fri": 20, "sat": 21, "sun": 22}[day]
		t, _ := time.ParseInLocation("2006-01-02 15:04", "2026-11-"+string(rune('0'+d/10))+string(rune('0'+d%10))+" "+hm, profile.Saratov)
		return t
	}
	cases := []struct {
		day, hm string
		open    bool
	}{
		{"fri", "17:59", false}, {"fri", "18:00", true}, {"fri", "23:30", true},
		{"sat", "01:30", true}, {"sat", "02:00", false}, {"sat", "13:00", true}, {"sat", "16:00", false},
		{"sat", "23:59", true}, {"sun", "00:30", false},
	}
	for _, c := range cases {
		open, known := h.OpenAt(at(c.day, c.hm))
		if !known || open != c.open {
			t.Errorf("%s %s: open=%v known=%v, want %v", c.day, c.hm, open, known, c.open)
		}
	}
	if _, known := (Hours{}).OpenAt(time.Now()); known {
		t.Error("empty hours must be unknown")
	}
}
