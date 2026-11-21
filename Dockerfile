# Сервер вместе с FFmpeg: так обработка видео и звука работает одинаково на любой машине и в проде.
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/music .

FROM alpine:3.22
RUN apk add --no-cache ffmpeg ca-certificates tzdata
COPY --from=build /out/music /usr/local/bin/
ENV ADDR=:8080 MEDIA_DIR=/data/media
EXPOSE 8080
CMD ["music"]
