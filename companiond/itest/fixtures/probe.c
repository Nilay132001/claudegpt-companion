// SYNTHETIC FIXTURE — Seatbelt probe for itest/codeMode.itest.ts. Run in the relay's exec slot of a MEASUREMENT-ONLY
// copy of the production profile, it tries each action given as an argument and prints one JSON line per action
// with the errno it got. It reads and sends no data: a connect that succeeds is closed at once, an open for reading
// is closed without a read. Point it only at decoys and synthetic files the caller made.
//   unix:<path>  connect      tcp:<port>  127.0.0.1      tcp6:<port>  ::1      host:<name>:<port>  DNS + connect
//   bind:<path>  bind a unix socket      bindtcp:<ipv4>:<port>  bind + listen a TCP socket, closed at once
//   exec:<path>  fork + execve, no arguments, empty env
//   read:<path>  open O_RDONLY, no read  write:<path> open O_WRONLY, no data   unlink:<path>
//   rename:<from>><to>                   link:<from>><to>  create a hard link
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

#define EAI_FAILED (-1)

static const char *ename(int e) {
  switch (e) {
    case 0: return "OK";
    case EPERM: return "EPERM";
    case EACCES: return "EACCES";
    case ENOENT: return "ENOENT";
    case ECONNREFUSED: return "ECONNREFUSED";
    case EADDRINUSE: return "EADDRINUSE";
    case ETIMEDOUT: return "ETIMEDOUT";
    case EAI_FAILED: return "EAI";
    default: return "OTHER";
  }
}

static int do_unix(const char *path, int bind_it) {
  struct sockaddr_un a;
  memset(&a, 0, sizeof a);
  a.sun_family = AF_UNIX;
  if (strlen(path) >= sizeof a.sun_path) return ENAMETOOLONG;
  strcpy(a.sun_path, path);
  int s = socket(AF_UNIX, SOCK_STREAM, 0);
  if (s < 0) return errno;
  int rc = bind_it ? bind(s, (struct sockaddr *)&a, sizeof a) : connect(s, (struct sockaddr *)&a, sizeof a);
  int e = rc == 0 ? 0 : errno;
  close(s);
  if (bind_it && rc == 0) unlink(path);
  return e;
}

static int do_tcp(const char *port, int v6) {
  int s = socket(v6 ? AF_INET6 : AF_INET, SOCK_STREAM, 0);
  if (s < 0) return errno;
  int rc;
  if (v6) {
    struct sockaddr_in6 a;
    memset(&a, 0, sizeof a);
    a.sin6_family = AF_INET6;
    a.sin6_port = htons((unsigned short)atoi(port));
    a.sin6_addr = in6addr_loopback;
    rc = connect(s, (struct sockaddr *)&a, sizeof a);
  } else {
    struct sockaddr_in a;
    memset(&a, 0, sizeof a);
    a.sin_family = AF_INET;
    a.sin_port = htons((unsigned short)atoi(port));
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    rc = connect(s, (struct sockaddr *)&a, sizeof a);
  }
  int e = rc == 0 ? 0 : errno;
  close(s);
  return e;
}

static int do_host(const char *arg) {
  char host[256];
  const char *colon = strrchr(arg, ':');
  if (colon == NULL || (size_t)(colon - arg) >= sizeof host) return EINVAL;
  memcpy(host, arg, (size_t)(colon - arg));
  host[colon - arg] = 0;
  struct addrinfo hints, *res = NULL;
  memset(&hints, 0, sizeof hints);
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  if (getaddrinfo(host, colon + 1, &hints, &res) != 0 || res == NULL) return EAI_FAILED;
  int s = socket(res->ai_family, res->ai_socktype, res->ai_protocol);
  int e = s < 0 ? errno : (connect(s, res->ai_addr, res->ai_addrlen) == 0 ? 0 : errno);
  if (s >= 0) close(s);
  freeaddrinfo(res);
  return e;
}

static int do_bindtcp(const char *arg) {
  char host[64];
  const char *colon = strrchr(arg, ':');
  if (colon == NULL || (size_t)(colon - arg) >= sizeof host) return EINVAL;
  memcpy(host, arg, (size_t)(colon - arg));
  host[colon - arg] = 0;
  struct sockaddr_in a;
  memset(&a, 0, sizeof a);
  a.sin_family = AF_INET;
  a.sin_port = htons((unsigned short)atoi(colon + 1));
  if (inet_pton(AF_INET, host, &a.sin_addr) != 1) return EINVAL;
  int s = socket(AF_INET, SOCK_STREAM, 0);
  if (s < 0) return errno;
  int one = 1;
  setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
  int e = bind(s, (struct sockaddr *)&a, sizeof a) == 0 ? (listen(s, 1) == 0 ? 0 : errno) : errno;
  close(s);
  return e;
}

static int two_paths(const char *arg, char *from, size_t n, const char **to) {
  const char *gt = strchr(arg, '>');
  if (gt == NULL || (size_t)(gt - arg) >= n) return -1;
  memcpy(from, arg, (size_t)(gt - arg));
  from[gt - arg] = 0;
  *to = gt + 1;
  return 0;
}

static int do_exec(const char *path) {
  int p[2];
  if (pipe(p) != 0) return errno;
  fcntl(p[1], F_SETFD, FD_CLOEXEC);
  pid_t pid = fork();
  if (pid < 0) return errno;
  if (pid == 0) {
    close(p[0]);
    int dn = open("/dev/null", O_RDWR);
    if (dn >= 0) {
      dup2(dn, 0);
      dup2(dn, 1);
      dup2(dn, 2);
    }
    char *argv[] = {(char *)path, NULL};
    char *envp[] = {NULL};
    execve(path, argv, envp);
    int e = errno;
    (void)!write(p[1], &e, sizeof e);
    _exit(127);
  }
  close(p[1]);
  int e = 0;
  ssize_t n = read(p[0], &e, sizeof e);
  close(p[0]);
  int st;
  waitpid(pid, &st, 0);
  return n == (ssize_t)sizeof e ? e : 0;
}

int main(int argc, char **argv) {
  for (int i = 1; i < argc; i++) {
    const char *a = argv[i];
    const char *colon = strchr(a, ':');
    if (colon == NULL) continue;
    const char *arg = colon + 1;
    int e;
    if (strncmp(a, "unix:", 5) == 0) e = do_unix(arg, 0);
    else if (strncmp(a, "bind:", 5) == 0) e = do_unix(arg, 1);
    else if (strncmp(a, "tcp:", 4) == 0) e = do_tcp(arg, 0);
    else if (strncmp(a, "tcp6:", 5) == 0) e = do_tcp(arg, 1);
    else if (strncmp(a, "host:", 5) == 0) e = do_host(arg);
    else if (strncmp(a, "bindtcp:", 8) == 0) e = do_bindtcp(arg);
    else if (strncmp(a, "exec:", 5) == 0) e = do_exec(arg);
    else if (strncmp(a, "read:", 5) == 0) {
      int fd = open(arg, O_RDONLY);
      e = fd >= 0 ? 0 : errno;
      if (fd >= 0) close(fd);
    } else if (strncmp(a, "write:", 6) == 0) {
      int fd = open(arg, O_WRONLY); // no truncation, no data
      e = fd >= 0 ? 0 : errno;
      if (fd >= 0) close(fd);
    } else if (strncmp(a, "unlink:", 7) == 0) e = unlink(arg) == 0 ? 0 : errno;
    else if (strncmp(a, "rename:", 7) == 0 || strncmp(a, "link:", 5) == 0) {
      char from[1024];
      const char *to = NULL;
      if (two_paths(arg, from, sizeof from, &to) != 0) e = EINVAL;
      else if (a[0] == 'r') e = rename(from, to) == 0 ? 0 : errno;
      else e = link(from, to) == 0 ? 0 : errno;
    } else continue;
    printf("{\"action\":%d,\"errno\":\"%s\"}\n", i, ename(e));
  }
  return 0;
}
