package media

import (
	"context"
	"log/slog"
	"time"
)

// Queue — фоновая обработка в несколько потоков внутри процесса.
// Задачи не теряются при перезапуске: статус processing хранится в базе,
// и при старте сервисы заново ставят такие записи в очередь (Resume).
type Queue struct {
	jobs chan job
	log  *slog.Logger
}

type job struct {
	name string
	fn   func(context.Context) error
}

func NewQueue(workers int, log *slog.Logger) *Queue {
	q := &Queue{jobs: make(chan job, 1000), log: log}
	for i := 0; i < workers; i++ {
		go q.work()
	}
	return q
}

func (q *Queue) Add(name string, fn func(context.Context) error) {
	select {
	case q.jobs <- job{name, fn}:
	default:
		go func() { q.jobs <- job{name, fn} }()
	}
}

func (q *Queue) work() {
	for j := range q.jobs {
		q.run(j)
	}
}

func (q *Queue) run(j job) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	defer func() {
		if v := recover(); v != nil {
			q.log.Error("job panic", "job", j.name, "err", v)
		}
	}()
	start := time.Now()
	if err := j.fn(ctx); err != nil {
		q.log.Error("job failed", "job", j.name, "err", err)
		return
	}
	q.log.Info("job done", "job", j.name, "took", time.Since(start).Round(time.Millisecond))
}
