import argparse
import datetime
import hashlib
import json
import os
import pathlib
import platform
import subprocess
import time

p = argparse.ArgumentParser()
p.add_argument('--root', required=True)
p.add_argument('--out', required=True)
p.add_argument('--label', required=True)
p.add_argument('--before', action='store_true')
args = p.parse_args()
root = pathlib.Path(args.root).resolve()
out = pathlib.Path(args.out).resolve()
out.mkdir(parents=True, exist_ok=True)
home = out / (args.label + '-home')
home.mkdir(exist_ok=True)
env = os.environ.copy()
for key in list(env):
    if key.startswith('TEAMAI_TEST_') or key in ['GITHUB_TOKEN', 'GH_TOKEN', 'GITLAB_TOKEN', 'GITCODE_TOKEN', 'CNB_TOKEN', 'CODEX_HOME', 'NODE_OPTIONS', 'GIT_CONFIG_GLOBAL']:
        env.pop(key, None)
env.update(HOME=str(home), USERPROFILE=str(home), FORCE_COLOR='0', GIT_CONFIG_NOSYSTEM='1',
           GIT_AUTHOR_NAME='TeamAI CI', GIT_AUTHOR_EMAIL='ci@teamai.test',
           GIT_COMMITTER_NAME='TeamAI CI', GIT_COMMITTER_EMAIL='ci@teamai.test')
subprocess.run(['git', 'config', '--global', 'user.name', 'TeamAI CI'], env=env, check=True)
subprocess.run(['git', 'config', '--global', 'user.email', 'ci@teamai.test'], env=env, check=True)
report = out / (args.label + '.json')
commands = []
if args.before:
    commands.append(['npm', 'run', 'build'])
commands.append(['npm', 'run', 'test:e2e', '--', '--retry=0', '--cache=false', '--reporter=default', '--reporter=json', '--outputFile.json=' + str(report)])
meta = dict(label=args.label, sha=subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip(),
            node=subprocess.check_output(['node', '--version'], text=True).strip(),
            npm=subprocess.check_output(['npm', '--version'], text=True).strip(),
            platform=platform.platform(), cpus=os.cpu_count(), ci=bool(env.get('CI')),
            lock_sha256=hashlib.sha256((root / 'package-lock.json').read_bytes()).hexdigest(),
            root=str(root), commands=commands, started_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
            retry=0, cache=False, remote_credentials=False, load_start=list(os.getloadavg()))
meta_file = out / (args.label + '-meta.json')
meta_file.write_text(json.dumps(meta, indent=2))
print('Started', args.label, meta['sha'], meta['node'], flush=True)
start = time.monotonic()
code = 0
with (out / (args.label + '.log')).open('w') as log:
    for command in commands:
        log.write('$ ' + ' '.join(command) + '\n')
        log.flush()
        code = subprocess.call(command, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
        if code:
            break
meta.update(seconds=time.monotonic() - start, exit_code=code,
            completed_at=datetime.datetime.now(datetime.timezone.utc).isoformat(), load_end=list(os.getloadavg()))
if report.exists():
    result = json.loads(report.read_text())
    meta['counts'] = {key: result[key] for key in ['numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests']}
meta_file.write_text(json.dumps(meta, indent=2))
print('Finished', args.label, 'exit', code, 'seconds', round(meta['seconds'], 3), meta.get('counts'), flush=True)
