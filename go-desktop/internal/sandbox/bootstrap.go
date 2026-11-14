package sandbox

import "github.com/snakex21/benchforge/go-desktop/internal/jsv"

// The bootstraps are identical to electron/toolRuntime.cjs. On the host they
// are the only (best-effort) network barrier; in Docker the container has no
// network at all.

func pythonBootstrap(userFile string) string {
	f := jsv.JSONString(userFile)
	return `import builtins
import os
import socket
import sys

class BenchForgeNetworkBlocked(RuntimeError):
    pass

def _blocked(*args, **kwargs):
    raise BenchForgeNetworkBlocked('Network access is blocked by BenchForge tool runtime')

socket.socket = _blocked
socket.create_connection = _blocked

_real_import = builtins.__import__
_blocked_modules = {'urllib', 'http', 'ftplib', 'smtplib', 'poplib', 'imaplib', 'telnetlib', 'socketserver', 'requests', 'aiohttp', 'websocket'}
def _guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
    root = name.split('.')[0]
    if root in _blocked_modules:
        raise ImportError(f'Module {name} is blocked by BenchForge tool runtime')
    return _real_import(name, globals, locals, fromlist, level)
builtins.__import__ = _guarded_import

with open(` + f + `, 'r', encoding='utf-8') as _benchforge_file:
    _code = compile(_benchforge_file.read(), ` + f + `, 'exec')
exec(_code, {'__name__': '__main__', '__file__': ` + f + `})
`
}

func nodeBootstrap(userFile string) string {
	return `const Module = require('module')
const blocked = new Set(['net', 'tls', 'http', 'https', 'http2', 'dgram', 'dns', 'child_process', 'cluster'])
const originalLoad = Module._load
Module._load = function(request, parent, isMain) {
  if (blocked.has(request)) throw new Error('Module ' + request + ' is blocked by BenchForge tool runtime')
  return originalLoad.apply(this, arguments)
}
global.fetch = async function() { throw new Error('Network access is blocked by BenchForge tool runtime') }
require(` + jsv.JSONString("./"+userFile) + `)
`
}
