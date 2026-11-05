// companion relay (spec §7.1.9, M4a). The only program Codex may exec besides itself and its code-mode host:
// a byte relay between its stdio and ONE unix socket. The path is compiled in (RELAY_SOCKET, from a header that
// companiond generates: src/relay/relayBuild.ts). No arguments, no files, no other env.
// The per-thread token comes from env CGC_RELAY_TOKEN (64 lowercase hex chars) and never goes on the wire:
//   companiond -> relay  "CGC1 " <64 hex nonce> "\n"
//   relay -> companiond  hex(HMAC-SHA256(token, nonce || "relay")) "\n"
//   companiond -> relay  hex(HMAC-SHA256(token, nonce || "reader")) "\n"   checked before any stdin byte is read
//   validator -> relay   "OK\n"                                            the sandboxed validator owns the socket now
// Then bytes flow both ways. Any error ends the process; it never falls back to anything.
// The relay is a convenience, not a boundary: it runs inside Codex's own Seatbelt profile.
// Exit codes: 0 socket closed normally, 64 bad or missing token, 65 socket path too long,
// 66 handshake failed (bad framing, wrong proof, timeout), 69 connect failed, 70 I/O error.
#include <CommonCrypto/CommonHMAC.h>
#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#ifndef RELAY_SOCKET
#error "build through companiond (src/relay/relayBuild.ts): it defines RELAY_SOCKET in a generated header"
#endif

#define TOKEN_LEN 64
#define HEX_LEN 64
#define NONCE_LEN 32
#define HELLO "CGC1 "
#define HELLO_LEN 5
#define WAIT_MS 5000

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

// Reads exactly n bytes; each wait is at most ms. 0 on success, -1 on EOF, error, POLLNVAL or timeout.
static int read_exact(int fd, char *p, size_t n, int ms) {
  while (n > 0) {
    struct pollfd q = {fd, POLLIN, 0};
    int r = poll(&q, 1, ms);
    if (r < 0 && errno == EINTR) continue;
    if (r <= 0 || (q.revents & POLLNVAL)) return -1;
    ssize_t got = read(fd, p, n);
    if (got < 0 && errno == EINTR) continue;
    if (got <= 0) return -1;
    p += got;
    n -= (size_t)got;
  }
  return 0;
}

static int hexval(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  return -1;
}

static int is_hex(const char *s, size_t n) {
  for (size_t i = 0; i < n; i++)
    if (hexval(s[i]) < 0) return 0;
  return 1;
}

static void unhex(const char *s, unsigned char *out, size_t bytes) {
  for (size_t i = 0; i < bytes; i++) out[i] = (unsigned char)(hexval(s[2 * i]) << 4 | hexval(s[2 * i + 1]));
}

static void proof(const char *token, const unsigned char *nonce, const char *label, char *out_hex) {
  static const char digits[] = "0123456789abcdef";
  unsigned char msg[NONCE_LEN + 8];
  size_t ln = strlen(label);
  memcpy(msg, nonce, NONCE_LEN);
  memcpy(msg + NONCE_LEN, label, ln);
  unsigned char mac[CC_SHA256_DIGEST_LENGTH];
  CCHmac(kCCHmacAlgSHA256, token, TOKEN_LEN, msg, NONCE_LEN + ln, mac);
  for (size_t i = 0; i < sizeof mac; i++) {
    out_hex[2 * i] = digits[mac[i] >> 4];
    out_hex[2 * i + 1] = digits[mac[i] & 15];
  }
  memset(mac, 0, sizeof mac);
}

static int same(const char *a, const char *b, size_t n) {
  unsigned char x = 0;
  for (size_t i = 0; i < n; i++) x |= (unsigned char)(a[i] ^ b[i]);
  return x == 0;
}

int main(void) {
  signal(SIGPIPE, SIG_IGN);
  char token[TOKEN_LEN + 1];
  char hello[HELLO_LEN + HEX_LEN + 1];
  char mine[HEX_LEN + 1];
  char theirs[HEX_LEN + 1];
  char want[HEX_LEN];
  char ready[3];
  unsigned char nonce[NONCE_LEN];
  char buf[65536];
  int rc = 66;
  int in_open = 1;

  const char *t = getenv("CGC_RELAY_TOKEN");
  if (t == NULL || strlen(t) != TOKEN_LEN || !is_hex(t, TOKEN_LEN)) return 64;
  memcpy(token, t, TOKEN_LEN + 1);
  unsetenv("CGC_RELAY_TOKEN"); // note: the initial env stays readable through KERN_PROCARGS2 (spec §7.1.9 residual risk)

  struct sockaddr_un a;
  memset(&a, 0, sizeof a);
  a.sun_family = AF_UNIX;
  if (strlen(RELAY_SOCKET) >= sizeof a.sun_path) {
    rc = 65;
    goto done;
  }
  strcpy(a.sun_path, RELAY_SOCKET);
  int s = socket(AF_UNIX, SOCK_STREAM, 0);
  if (s < 0 || connect(s, (struct sockaddr *)&a, sizeof a) != 0) {
    rc = 69;
    goto done;
  }

  if (read_exact(s, hello, sizeof hello, WAIT_MS) != 0) goto done;
  if (memcmp(hello, HELLO, HELLO_LEN) != 0 || hello[sizeof hello - 1] != '\n' || !is_hex(hello + HELLO_LEN, HEX_LEN)) goto done;
  unhex(hello + HELLO_LEN, nonce, NONCE_LEN);
  proof(token, nonce, "relay", mine);
  mine[HEX_LEN] = '\n';
  if (write_all(s, mine, sizeof mine) != 0) goto done; // the peer went away mid-handshake: 66
  if (read_exact(s, theirs, sizeof theirs, WAIT_MS) != 0 || theirs[HEX_LEN] != '\n') goto done;
  proof(token, nonce, "reader", want);
  if (!same(theirs, want, HEX_LEN)) goto done;
  if (read_exact(s, ready, sizeof ready, WAIT_MS) != 0 || memcmp(ready, "OK\n", 3) != 0) goto done;
  memset(token, 0, sizeof token);
  memset(want, 0, sizeof want);

  for (;;) {
    struct pollfd p[2] = {{s, POLLIN, 0}, {STDIN_FILENO, POLLIN, 0}};
    int n = poll(p, in_open ? 2 : 1, -1);
    if (n < 0) {
      if (errno == EINTR) continue;
      return 70;
    }
    // A closed or invalid fd reports POLLNVAL forever: treat it as fatal instead of spinning (review M3).
    if ((p[0].revents & POLLNVAL) || (in_open && (p[1].revents & POLLNVAL))) return 70;
    if (p[0].revents & (POLLIN | POLLHUP | POLLERR)) {
      ssize_t r = read(s, buf, sizeof buf);
      if (r < 0 && errno == EINTR) continue;
      if (r <= 0) return r == 0 ? 0 : 70; // companiond closed: Codex sees EOF
      if (write_all(STDOUT_FILENO, buf, (size_t)r) != 0) return 70;
    }
    if (in_open && (p[1].revents & (POLLIN | POLLHUP | POLLERR))) {
      ssize_t r = read(STDIN_FILENO, buf, sizeof buf);
      if (r < 0 && errno == EINTR) continue;
      if (r < 0) return 70;
      if (r == 0) {
        in_open = 0; // Codex closed stdin: tell the validator, keep draining its replies
        shutdown(s, SHUT_WR);
        continue;
      }
      if (write_all(s, buf, (size_t)r) != 0) return 70;
    }
  }

done:
  memset(token, 0, sizeof token);
  return rc;
}
