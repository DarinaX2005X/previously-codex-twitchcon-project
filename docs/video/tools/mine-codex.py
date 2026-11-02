"""Mine real counts from the Codex session transcript for the film's Codex passage.
Prints only counts, names and timestamps (never message bodies: the transcript holds secrets).
python mine-codex.py > codex-facts.json"""
import json, glob, os, collections, subprocess, sys
SESS = os.path.expanduser('~/.codex/sessions/2026/11')
MAIN = os.path.join(SESS, '01', 'rollout-2026-11-01T23-57-41-01a19879-7da5-79b3-8c12-6e50d95c2250.jsonl')
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
LAST_CODEX_COMMIT = '800b69a'  # later commits belong to the Claude redesign pass

def scan(path):
    calls = 0; first = last = None; spawned = []; models = collections.Counter(); owner = 0; meta = {}
    with open(path, encoding='utf-8') as f:
        for line in f:
            d = json.loads(line); ts = d.get('timestamp'); first = first or ts; last = ts or last
            p = d.get('payload') or {}
            if not isinstance(p, dict): continue
            if d['type'] == 'session_meta': meta = {k: p.get(k) for k in ('id', 'agent_path', 'parent_thread_id')}
            if p.get('type') in ('function_call', 'custom_tool_call'):
                calls += 1
                if p.get('name') == 'spawn_agent':
                    try:
                        a = json.loads(p.get('arguments') or '{}'); spawned.append(a.get('task_name')); models[a.get('model')] += 1
                    except Exception: pass
            if d['type'] == 'response_item' and p.get('type') == 'message' and p.get('role') == 'user':
                txt = ' '.join(c.get('text', '') for c in p.get('content', []) if isinstance(c, dict))
                if not txt.startswith(('<', '# AGENTS')): owner += 1
    return dict(calls=calls, first=first, last=last, spawned=spawned, models=dict(models), owner_messages=owner, meta=meta)

main = scan(MAIN)
workers = []
for path in sorted(glob.glob(os.path.join(SESS, '*', '*.jsonl'))):
    if path == MAIN: continue
    s = scan(path)
    if s['meta'].get('parent_thread_id') and str(s['meta'].get('agent_path', '')).startswith('/root/'):
        workers.append({'name': s['meta']['agent_path'][6:], 'tool_calls': s['calls'], 'first': s['first'], 'last': s['last']})
commits = subprocess.run(['git', '-C', REPO, 'rev-list', '--count', LAST_CODEX_COMMIT], capture_output=True, text=True).stdout.strip()
shortstat = subprocess.run(['git', '-C', REPO, 'diff', '--shortstat', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', LAST_CODEX_COMMIT], capture_output=True, text=True).stdout.strip()
facts = {
    'session_id': main['meta'].get('id'), 'session_start_utc': main['first'], 'session_end_utc': main['last'],
    'main_tool_calls': main['calls'], 'owner_messages': main['owner_messages'],
    'workers_spawned': len(main['spawned']), 'worker_models': main['models'],
    'workers': workers, 'worker_tool_calls': sum(w['tool_calls'] for w in workers),
    'total_tool_calls': main['calls'] + sum(w['tool_calls'] for w in workers),
    'codex_commits': int(commits or 0), 'codex_shortstat': shortstat,
    'tests_full_integration': '609 tests across 67 files (docs/testing/functional/release-preflight.md)',
    'intake': '1,000 messages at 20 per second without a gap, receive-to-commit p95 49.84 ms (submission journal)',
    'engine_partial_run': '280,780 chats over 3.80 virtual hours, ended early (submission journal)',
}
json.dump(facts, sys.stdout, indent=1, ensure_ascii=False)
