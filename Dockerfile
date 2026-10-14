# syntax=docker/dockerfile:1
# The raaqeb image: the compiled binary on distroless, non-root,
# no shell and no entrypoint script. `bun run image` compiles the binaries
# into dist/bin first and passes the labels (scripts/package.ts).

# Each platform takes its own glibc binary.
FROM scratch AS bin-amd64
COPY dist/bin/raaqeb-linux-x64 /raaqeb
FROM scratch AS bin-arm64
COPY dist/bin/raaqeb-linux-arm64 /raaqeb
FROM bin-${TARGETARCH} AS bin

# The data folder, as a layer to copy: the distroless image has no shell to chmod with.
FROM scratch AS data
WORKDIR /data

# cc-debian12:nonroot, pinned by its multi-arch index digest.
FROM gcr.io/distroless/cc-debian12:nonroot@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f
COPY --from=bin --chmod=0755 /raaqeb /usr/local/bin/raaqeb
USER 65532:65532
# Private (0700) and owned by the non-root user, so a fresh named volume takes
# both and the start logs no mode warning. A bind mount needs
# `docker run --user "$(id -u):$(id -g)"` for a folder the host user owns.
COPY --from=data --chown=65532:65532 --chmod=0700 /data /data
WORKDIR /data
ENV RAAQEB_DATA_DIR=/data RAAQEB_HOST=0.0.0.0
VOLUME /data
EXPOSE 3000
# Every two seconds while it starts, then every thirty.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=2s --retries=3 \
  CMD ["/usr/local/bin/raaqeb", "health"]
ENTRYPOINT ["/usr/local/bin/raaqeb"]
CMD ["serve"]
