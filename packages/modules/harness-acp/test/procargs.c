// Owned-process canary only: Darwin's KERN_PROCARGS2 includes argv and environment.
#include <sys/types.h>
#include <sys/sysctl.h>
#include <stdio.h>
#include <stdlib.h>
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  int mib[] = { CTL_KERN, KERN_PROCARGS2, atoi(argv[1]) };
  size_t size = 1024 * 1024;
  char *buffer = calloc(1, size);
  if (!buffer || sysctl(mib, 3, buffer, &size, NULL, 0) != 0) { perror("sysctl"); free(buffer); return 1; }
  fwrite(buffer, 1, size, stdout); free(buffer); return 0;
}
