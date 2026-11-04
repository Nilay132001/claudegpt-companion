// SPIKE (M4a option b). Sandbox probe: run in the relay's exec slot of a profile, it tries each action given
// as an argument and prints one JSON line per action with the errno it got. It sends no data anywhere:
// a connect that succeeds is closed at once. Use only decoy sockets and ports the caller created.
//   unix:<path>  connect to a unix socket      tcp:<port>  connect to 127.0.0.1:<port>
//   bind:<path>  bind a new unix socket        exec:<path> fork + execve(path) with no arguments
//   write:<path> open for writing (no data)    unlink:<path> remove a file (point it only at files it may lose)
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

static const char *ename(int e) {
  switch (e) {
    case 0: return "OK";
    case EPERM: return "EPERM";
    case EACCES: return "EACCES";
    case ENOENT: return "ENOENT";
    case ECONNREFUSED: return "ECONNREFUSED";
    case EADDRINUSE: return "EADDRINUSE";
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

static int do_tcp(const char *port) {
  struct sockaddr_in a;
  memset(&a, 0, sizeof a);
  a.sin_family = AF_INET;
  a.sin_port = htons((unsigned short)atoi(port));
  a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  int s = socket(AF_INET, SOCK_STREAM, 0);
  if (s < 0) return errno;
  int e = connect(s, (struct sockaddr *)&a, sizeof a) == 0 ? 0 : errno;
  close(s);
  return e;
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
    else if (strncmp(a, "tcp:", 4) == 0) e = do_tcp(arg);
    else if (strncmp(a, "exec:", 5) == 0) e = do_exec(arg);
    else if (strncmp(a, "write:", 6) == 0) {
      // Opens for writing without truncating and writes nothing.
      int fd = open(arg, O_WRONLY);
      e = fd >= 0 ? 0 : errno;
      if (fd >= 0) close(fd);
    } else if (strncmp(a, "unlink:", 7) == 0) e = unlink(arg) == 0 ? 0 : errno;
    else continue;
    printf("{\"action\":%d,\"errno\":\"%s\",\"code\":%d}\n", i, ename(e), e);
  }
  return 0;
}
