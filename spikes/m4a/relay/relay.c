// SPIKE (M4a option b). The only program Codex may exec: a byte relay between its stdio and ONE unix socket.
// The socket path is fixed at build time (-DRELAY_SOCKET="..."); nothing at run time can point it elsewhere.
// The per-thread token comes from env CGC_RELAY_TOKEN (64 hex chars) and is sent once, as the first line.
// No arguments, no files, no other env. Any error ends the process; it never falls back to anything.
// Exit codes: 0 socket closed normally, 64 bad token/env, 65 socket path too long, 69 connect failed, 70 I/O error.
#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#ifndef RELAY_SOCKET
#error "build with -DRELAY_SOCKET=\"/absolute/path/to/socket\""
#endif

#define TOKEN_LEN 64

static int write_all(int fd, const char *p, size_t n) {
  while (n > 0) {
    ssize_t w = write(fd, p, n);
    if (w < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    p += w;
    n -= (size_t)w;
  }
  return 0;
}

static int is_hex(const char *s, size_t n) {
  for (size_t i = 0; i < n; i++) {
    char c = s[i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return 0;
  }
  return 1;
}

int main(void) {
  signal(SIGPIPE, SIG_IGN);
  char line[TOKEN_LEN + 1];
  const char *t = getenv("CGC_RELAY_TOKEN");
  if (t == NULL || strlen(t) != TOKEN_LEN || !is_hex(t, TOKEN_LEN)) return 64;
  memcpy(line, t, TOKEN_LEN);
  line[TOKEN_LEN] = '\n';
  unsetenv("CGC_RELAY_TOKEN");

  struct sockaddr_un a;
  memset(&a, 0, sizeof a);
  a.sun_family = AF_UNIX;
  if (strlen(RELAY_SOCKET) >= sizeof a.sun_path) return 65;
  strcpy(a.sun_path, RELAY_SOCKET);
  int s = socket(AF_UNIX, SOCK_STREAM, 0);
  if (s < 0) return 69;
  if (connect(s, (struct sockaddr *)&a, sizeof a) != 0) return 69;
  int rc = write_all(s, line, sizeof line);
  memset(line, 0, sizeof line);
  if (rc != 0) return 70;

  char buf[65536];
  int in_open = 1;
  for (;;) {
    struct pollfd p[2] = {{s, POLLIN, 0}, {STDIN_FILENO, POLLIN, 0}};
    int n = poll(p, in_open ? 2 : 1, -1);
    if (n < 0) {
      if (errno == EINTR) continue;
      return 70;
    }
    if (p[0].revents & (POLLIN | POLLHUP | POLLERR)) {
      ssize_t r = read(s, buf, sizeof buf);
      if (r < 0 && errno == EINTR) continue;
      if (r <= 0) return r == 0 ? 0 : 70; // the reader closed: Codex sees EOF, the tool call ends
      if (write_all(STDOUT_FILENO, buf, (size_t)r) != 0) return 70;
    }
    if (in_open && (p[1].revents & (POLLIN | POLLHUP | POLLERR))) {
      ssize_t r = read(STDIN_FILENO, buf, sizeof buf);
      if (r < 0 && errno == EINTR) continue;
      if (r < 0) return 70;
      if (r == 0) {
        in_open = 0; // Codex closed stdin: tell the reader, keep draining its replies
        shutdown(s, SHUT_WR);
        continue;
      }
      if (write_all(s, buf, (size_t)r) != 0) return 70;
    }
  }
}
