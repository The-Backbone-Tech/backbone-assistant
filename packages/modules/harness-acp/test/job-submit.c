// Disposable user-domain launchd job canary; no desktop or account interaction.
#include <CoreFoundation/CoreFoundation.h>
#include <ServiceManagement/ServiceManagement.h>
#include <stdio.h>
#include <string.h>
int main(int argc, char **argv) {
  if (argc < 3) return 2;
  CFStringRef label = CFStringCreateWithCString(NULL, argv[2], kCFStringEncodingUTF8);
  CFErrorRef error = NULL; Boolean ok = false;
  if (strcmp(argv[1], "remove") == 0) {
    ok = SMJobRemove(kSMDomainUserLaunchd, label, NULL, true, &error);
    CFDictionaryRef remaining = SMJobCopyDictionary(kSMDomainUserLaunchd, label);
    ok = remaining == NULL;
    if (remaining) CFRelease(remaining);
  } else if (strcmp(argv[1], "submit") == 0 && argc == 4) {
    CFStringRef marker = CFStringCreateWithCString(NULL, argv[3], kCFStringEncodingUTF8);
    const void *arguments[] = { CFSTR("/usr/bin/touch"), marker };
    CFArrayRef args = CFArrayCreate(NULL, arguments, 2, &kCFTypeArrayCallBacks);
    const void *keys[] = { CFSTR("Label"), CFSTR("ProgramArguments"), CFSTR("RunAtLoad") };
    const void *values[] = { label, args, kCFBooleanTrue };
    CFDictionaryRef job = CFDictionaryCreate(NULL, keys, values, 3, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    ok = SMJobSubmit(kSMDomainUserLaunchd, job, NULL, &error);
    CFRelease(job); CFRelease(args); CFRelease(marker);
  }
  if (error) { fprintf(stderr, "ServiceManagement error %ld\n", (long) CFErrorGetCode(error)); CFRelease(error); }
  CFRelease(label); puts(ok ? "allowed" : "refused"); return ok ? 0 : 1;
}
