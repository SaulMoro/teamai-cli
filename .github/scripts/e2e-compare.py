import collections
import json
import pathlib
import sys

directory = pathlib.Path(sys.argv[1])
records = []
verdicts = []
for label in ['before', 'after']:
    meta = json.loads((directory / (label + '-meta.json')).read_text())
    report = json.loads((directory / (label + '.json')).read_text())
    cases = collections.Counter((str(pathlib.Path(f['name']).relative_to(meta['root'])), t['fullName'], t['status'])
                                for f in report['testResults'] for t in f['assertionResults'])
    records.append(meta)
    verdicts.append(cases)
assert records[0]['lock_sha256'] == records[1]['lock_sha256']
assert records[0]['node'] == records[1]['node']
inventories = [collections.Counter() for _ in verdicts]
for inventory, cases in zip(inventories, verdicts):
    for (file, name, status), count in cases.items():
        inventory[(file, name)] += count
assert inventories[0] == inventories[1], 'Different case inventory'
changes = [{'file': k[0], 'test': k[1], 'status': k[2], 'before_count': verdicts[0][k], 'after_count': verdicts[1][k]}
           for k in verdicts[0].keys() | verdicts[1].keys() if verdicts[0][k] != verdicts[1][k]]
failures = [{'file': k[0], 'test': k[1]} for k, count in verdicts[1].items() if k[2] == 'failed']
summary = dict(before_seconds=records[0]['seconds'], after_seconds=records[1]['seconds'],
               reduction_percent=(1 - records[1]['seconds'] / records[0]['seconds']) * 100,
               speedup=records[0]['seconds'] / records[1]['seconds'],
               cases=sum(verdicts[0].values()), identical_verdicts=not changes,
               verdict_changes=changes, failures=failures, variants=records)
(directory / 'comparison.json').write_text(json.dumps(summary, indent=2))
print(json.dumps({k: v for k, v in summary.items() if k != 'variants'}, indent=2))
