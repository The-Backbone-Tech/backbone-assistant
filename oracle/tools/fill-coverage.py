# Fill a coverage skeleton in order: python3 tools/fill-coverage.py core/<promise>/coverage.ts entries.json
import json, sys
path, entries = sys.argv[1], json.load(open(sys.argv[2]))
lines = open(path).read().split('\n')
out, i = [], 0
for line in lines:
    if "{ status: 'todo' as never }" in line:
        e = entries[i]; i += 1
        line = line.replace("{ status: 'todo' as never }", json.dumps(e, ensure_ascii=False))
    out.append(line)
assert i == len(entries), f'{i} placeholders, {len(entries)} entries'
open(path, 'w').write('\n'.join(out))
