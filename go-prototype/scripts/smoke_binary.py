"""Run a built binary end-to-end on loopback using synthetic offline data only."""
import json
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

binary = str(Path(sys.argv[1]).resolve())
fixture = json.loads((Path(__file__).resolve().parents[1] / 'examples/offline.json').read_text())
with tempfile.TemporaryDirectory() as directory:
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    process = subprocess.Popen([binary, '-listen', f'127.0.0.1:{port}', '-data-dir', directory], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        for _ in range(100):
            try:
                with urllib.request.urlopen(base + '/api/config', timeout=.5) as response:
                    config = json.load(response)
                break
            except (OSError, urllib.error.URLError):
                if process.poll() is not None:
                    raise RuntimeError(process.stderr.read().decode())
                time.sleep(.02)
        else:
            raise RuntimeError('server did not become ready')
        request = urllib.request.Request(base + '/api/runs', data=json.dumps(fixture).encode(), headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(request) as response:
            assert response.status == 202
            initial = json.load(response)
        for _ in range(100):
            with urllib.request.urlopen(base + '/api/runs/' + initial['id']) as response:
                final = json.load(response)
            if final['state'] != 'running':
                break
            time.sleep(.02)
        assert final['state'] == 'completed', final
        assert final['summaries'][0]['passed'] == 2 and final['summaries'][0]['failed'] == 1
        persisted = json.loads((Path(directory) / (final['id'] + '.json')).read_text())
        assert persisted == final
        print(json.dumps({'state': final['state'], 'contract': final['contract'], 'summaries': final['summaries'], 'persisted_identically': True}, indent=2))
    finally:
        process.send_signal(signal.SIGINT)
        try:
            process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
