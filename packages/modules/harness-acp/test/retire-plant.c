// Disposable macOS fixtures: ACLs at creation, cloned flags and a path longer than PATH_MAX.
#include <sys/stat.h>
#include <sys/acl.h>
#include <sys/clonefile.h>
#include <membership.h>
#include <uuid/uuid.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

int main(int argc, char **argv) {
  if (argc < 3) return 2;
  if (!strcmp(argv[1], "acl") || !strcmp(argv[1], "acl-fifo") || !strcmp(argv[1], "acl-sealed")) {
    acl_t acl = acl_init(1); acl_entry_t entry; acl_permset_t perms; uuid_t user;
    if (mbr_uid_to_uuid(getuid(), user) || acl_create_entry(&acl, &entry) || acl_set_tag_type(entry, ACL_EXTENDED_DENY) || acl_set_qualifier(entry, user) || acl_get_permset(entry, &perms) || acl_add_perm(perms, ACL_DELETE) || acl_set_permset(entry, perms)) return 3;
    filesec_t security = filesec_init(); mode_t mode = !strcmp(argv[1], "acl-sealed") ? 0000 : 0700;
    if (filesec_set_property(security, FILESEC_MODE, &mode) || filesec_set_property(security, FILESEC_ACL, &acl)) return 4;
    int result;
    if (!strcmp(argv[1], "acl-fifo")) result = mkfifox_np(argv[2], security);
    else if (!strcmp(argv[1], "acl-sealed")) { int fd = openx_np(argv[2], O_WRONLY | O_CREAT | O_EXCL, security); result = fd < 0 ? -1 : 0; if (fd >= 0) close(fd); }
    else result = mkdirx_np(argv[2], security); filesec_free(security); acl_free(acl);
    if (result) { perror("mkdirx_np"); return 5; }
  } else if (!strcmp(argv[1], "clone")) {
    if (argc != 4 || clonefile(argv[3], argv[2], 0)) { perror("clonefile"); return 6; }
  } else if (!strcmp(argv[1], "locked-directory")) {
    if (mkdir(argv[2], 0700)) return 14;
    int fd = open(argv[2], O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    if (fd < 0) return 15;
    int leaf = openat(fd, "native-state", O_WRONLY | O_CREAT, 0600); if (leaf < 0) return 16;
    close(leaf); if (fchmod(fd, 0000) || fchflags(fd, UF_IMMUTABLE)) return 17; close(fd);
  } else if (!strcmp(argv[1], "spaced-flags")) {
    if (mkdir(argv[2], 0700)) return 18;
    int fd = open(argv[2], O_RDONLY | O_DIRECTORY | O_NOFOLLOW); if (fd < 0) return 19;
    for (int i = 0; i < 257; i++) {
      char name[32]; snprintf(name, sizeof(name), "entry-%05d", i);
      int leaf = openat(fd, name, O_WRONLY | O_CREAT | O_EXCL, 0600); if (leaf < 0) return 20;
      if ((i == 0 || i == 256) && fchflags(leaf, UF_IMMUTABLE)) return 21; close(leaf);
    }
    close(fd);
  } else if (!strcmp(argv[1], "deep")) {
    if (mkdir(argv[2], 0700)) return 7;
    int fd = open(argv[2], O_RDONLY | O_DIRECTORY | O_NOFOLLOW); if (fd < 0) return 8;
    for (int i = 0; i < 160; i++) {
      const char *name = "a-directory-step-with-32-letters";
      if (mkdirat(fd, name, 0700)) return 9;
      int next = openat(fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW); close(fd); fd = next;
      if (fd < 0) return 10;
    }
    int leaf = openat(fd, "native-state", O_WRONLY | O_CREAT | O_EXCL, 0600); if (leaf < 0) return 11;
    if (write(leaf, "private", 7) != 7) return 12; close(leaf); close(fd);
  } else return 13;
  puts("planted"); return 0;
}
