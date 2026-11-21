package media

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// FFmpeg вызывает ffmpeg как внешнюю программу.
type FFmpeg struct {
	Bin string // путь к ffmpeg
}

var ErrNoFFmpeg = errors.New("ffmpeg не найден")

func (f FFmpeg) Check() error {
	if _, err := exec.LookPath(f.Bin); err != nil {
		return fmt.Errorf("%w: %s", ErrNoFFmpeg, f.Bin)
	}
	return nil
}

func (f FFmpeg) run(ctx context.Context, args ...string) error {
	cmd := exec.CommandContext(ctx, f.Bin, append([]string{"-hide_banner", "-loglevel", "error", "-y"}, args...)...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if len(msg) > 500 {
			msg = msg[len(msg)-500:]
		}
		return fmt.Errorf("ffmpeg: %w: %s", err, msg)
	}
	return nil
}

// TranscodeVideo приводит запись с любого телефона (MP4/AAC с iPhone, WebM/Opus с Android)
// к одному виду: вертикальный кадр 720×1280. Если видео горизонтальное или другой пропорции,
// по краям — размытая и затемнённая копия кадра вместо чёрных полос. Цвет чуть живее,
// громкость выровнена (EBU R128), чтобы в ленте записи не скакали по громкости.
// H.264/AAC MP4 с moov-атомом в начале — для быстрого старта.
func (f FFmpeg) TranscodeVideo(ctx context.Context, in, out string) error {
	const look = "[0:v]split=2[bg][fg];" +
		"[bg]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,boxblur=24:2,eq=brightness=-0.12:saturation=1.1[bgb];" +
		"[fg]scale=720:1280:force_original_aspect_ratio=decrease,eq=contrast=1.04:saturation=1.08[fgs];" +
		"[bgb][fgs]overlay=(W-w)/2:(H-h)/2,format=yuv420p,setsar=1[v]"
	return f.run(ctx, "-i", in,
		"-filter_complex", look, "-map", "[v]", "-map", "0:a?",
		"-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-profile:v", "high", "-r", "30",
		"-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
		"-c:a", "aac", "-b:a", "128k", "-ar", "44100",
		"-movflags", "+faststart", out)
}

// Poster — кадр для превью.
func (f FFmpeg) Poster(ctx context.Context, in, out string) error {
	return f.run(ctx, "-ss", "0.5", "-i", in, "-frames:v", "1", "-q:v", "4", out)
}

// TranscodeAudio приводит звук к AAC в M4A. normalize — выровнять громкость (для записей в ленту;
// минусы и партии не трогаем, чтобы сведение было честным).
func (f FFmpeg) TranscodeAudio(ctx context.Context, in, out, bitrate string, normalize bool) error {
	args := []string{"-i", in, "-vn"}
	if normalize {
		args = append(args, "-af", "loudnorm=I=-16:TP=-1.5:LRA=11")
	}
	return f.run(ctx, append(args, "-c:a", "aac", "-b:a", bitrate, "-ar", "44100", "-movflags", "+faststart", out)...)
}

// Avatar — квадрат 512×512 из центра картинки, JPEG. Перекодирование заодно убирает EXIF (в том числе геометку).
func (f FFmpeg) Avatar(ctx context.Context, in, out string) error {
	return f.run(ctx, "-i", in, "-frames:v", "1",
		"-vf", "crop='min(iw,ih)':'min(iw,ih)',scale=512:512,format=yuvj420p", "-map_metadata", "-1", "-q:v", "3", out)
}

// Peaks — громкость по отрезкам (0..1) для рисования волны, плюс точная длительность.
func (f FFmpeg) Peaks(ctx context.Context, in string, bins int) ([]float64, time.Duration, error) {
	const rate = 8000
	cmd := exec.CommandContext(ctx, f.Bin, "-hide_banner", "-loglevel", "error", "-i", in, "-vn", "-ac", "1", "-ar", strconv.Itoa(rate), "-f", "s16le", "-")
	out, err := cmd.Output()
	if err != nil {
		return nil, 0, fmt.Errorf("ffmpeg peaks: %w", err)
	}
	n := len(out) / 2
	if n == 0 {
		return nil, 0, errors.New("в файле нет звука")
	}
	if bins > n {
		bins = n
	}
	peaks := make([]float64, bins)
	max := 0.0
	for i := 0; i < n; i++ {
		v := math.Abs(float64(int16(binary.LittleEndian.Uint16(out[i*2:]))) / 32768)
		b := i * bins / n
		if v > peaks[b] {
			peaks[b] = v
		}
		if v > max {
			max = v
		}
	}
	for i := range peaks {
		if max > 0 {
			peaks[i] = math.Round(peaks[i]/max*1000) / 1000
		}
	}
	return peaks, time.Duration(n) * time.Second / rate, nil
}

type MixParams struct {
	StartMS     int     // с какого места минуса начинается партия
	OffsetMS    int     // сдвиг партии: + позже, − раньше
	GainBacking float64 // громкость минуса
	GainTrack   float64 // громкость партии
	Duration    time.Duration
}

// Mix сводит фрагмент минуса с партией кандидата.
func (f FFmpeg) Mix(ctx context.Context, backing, track, out string, p MixParams) error {
	shift := "anull"
	if p.OffsetMS > 0 {
		shift = fmt.Sprintf("adelay=%d:all=1", p.OffsetMS)
	} else if p.OffsetMS < 0 {
		shift = fmt.Sprintf("atrim=start=%.3f,asetpts=PTS-STARTPTS", float64(-p.OffsetMS)/1000)
	}
	filter := fmt.Sprintf("[0:a]volume=%.3f[a];[1:a]%s,volume=%.3f[b];[a][b]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[out]",
		p.GainBacking, shift, p.GainTrack)
	dur := p.Duration + 500*time.Millisecond
	return f.run(ctx,
		"-ss", fmt.Sprintf("%.3f", float64(p.StartMS)/1000), "-t", fmt.Sprintf("%.3f", dur.Seconds()), "-i", backing,
		"-i", track,
		"-filter_complex", filter, "-map", "[out]",
		"-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-movflags", "+faststart", out)
}
