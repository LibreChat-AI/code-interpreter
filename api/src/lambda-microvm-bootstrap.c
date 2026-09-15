#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static void respond(int client, const char *status, const char *body) {
  char response[256];
  int length = snprintf(response, sizeof(response),
    "HTTP/1.1 %s\r\nContent-Type: text/plain\r\nContent-Length: %zu\r\nConnection: close\r\n\r\n%s",
    status, strlen(body), body);
  send(client, response, (size_t)length, MSG_NOSIGNAL);
}

int main(void) {
  signal(SIGPIPE, SIG_IGN);
  int listener = socket(AF_INET, SOCK_STREAM, 0);
  int reuse = 1;
  struct sockaddr_in address = {
    .sin_family = AF_INET,
    .sin_port = htons(8080),
    .sin_addr.s_addr = htonl(INADDR_ANY),
  };
  if (listener < 0
    || setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse)) < 0
    || bind(listener, (struct sockaddr *)&address, sizeof(address)) < 0
    || listen(listener, 16) < 0) {
    perror("CodeAPI bootstrap listener");
    return 1;
  }

  for (;;) {
    int client = accept(listener, NULL, NULL);
    if (client < 0) {
      if (errno == EINTR) continue;
      perror("CodeAPI bootstrap accept");
      return 1;
    }
    char request[8193] = {0};
    ssize_t length = recv(client, request, sizeof(request) - 1, 0);
    int start = length > 0 && strcasestr(request, "\r\nx-codeapi-runner-start: 1\r\n") != NULL;
    respond(client, start ? "503 Service Unavailable" : "200 OK", start ? "starting" : "ok");
    close(client);
    if (!start) continue;

    close(listener);
    unsetenv("AWS_LAMBDA_MICROVM_IMAGE_ARN");
    unsetenv("AWS_LAMBDA_MICROVM_IMAGE_NAME");
    unsetenv("AWS_LAMBDA_MICROVM_IMAGE_VERSION");
    unsetenv("AWS_REGION");
    char *const argv[] = {"/sandbox_api/entrypoint.sh", NULL};
    execv(argv[0], argv);
    perror("CodeAPI runner startup");
    return 1;
  }
}
