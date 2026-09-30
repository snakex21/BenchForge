"""Actual built-binary smoke with synthetic data only; no browser rendering."""
import hashlib
import json
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

binary = str(Path(sys.argv[1]).resolve())
fixture = Path(__file__).resolve().parents[1] / 'examples/synthetic.json'
with tempfile.TemporaryDirectory() as tmp:
    path = Path(tmp) / 'snapshot.json'
    path.write_bytes(fixture.read_bytes())
    before = (hashlib.sha256(path.read_bytes()).hexdigest(), path.stat().st_mtime_ns)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    process = subprocess.Popen([binary, '-listen', f'127.0.0.1:{port}', '-snapshot', str(path)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        for _ in range(100):
            try:
                with urllib.request.urlopen(base + '/api/readonly/meta', timeout=.5) as response:
                    meta = json.load(response)
                break
            except OSError:
                if process.poll() is not None:
                    raise RuntimeError(process.stderr.read().decode())
                time.sleep(.02)
        else:
            raise RuntimeError('server did not become ready')
        assert meta['read_only'] is True
        with urllib.request.urlopen(base + '/api/readonly/models') as response:
            models = json.load(response)
        assert models[0]['name'] == 'Fixture Model A'
        with urllib.request.urlopen(base + '/api/readonly/tasks?benchmark_id=1') as response:
            tasks = json.load(response)
        assert len(tasks) == 2 and tasks[0]['name'] == 'Zadanie 1'
        with urllib.request.urlopen(base + '/') as response:
            assert b'Read-only snapshot' in response.read()
        try:
            urllib.request.urlopen(urllib.request.Request(base + '/api/readonly/models', data=b'{}', headers={'Content-Type':'application/json'}))
        except urllib.error.HTTPError as error:
            assert error.code == 403
        else:
            raise AssertionError('mutation accepted')
        after = (hashlib.sha256(path.read_bytes()).hexdigest(), path.stat().st_mtime_ns)
        assert before == after and len(list(Path(tmp).iterdir())) == 1
        print(json.dumps({'read_only':True, 'model_count':len(models), 'preserved_task_count':len(tasks), 'input_content_and_mtime_unchanged':True, 'mutations_rejected':True, 'new_data_files':0}, indent=2))
    finally:
        process.send_signal(signal.SIGINT)
        try:
            process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
