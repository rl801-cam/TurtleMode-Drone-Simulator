"""Minimal CDP driver for measuring the sim in a throwaway Brave profile.

usage: python3 -I cdp.py <repo_dir> <mode> [args...]
  probe [flags...]          -> report WebGL / WebGPU adapter info
  mem <map> [flags...]      -> load map via window.simulator.start, fly, report PSS per process type
  fps <map> [flags...]      -> frame rate with shadows on / frozen / off
  bench <path?query> [flags...] -> open a page that publishes window.benchResult and print it
                                   (BENCH_SHOT=<png> screenshot,
                                    BENCH_MEM=1 adds PSS / heap / GPU memory)
  record <path?query> <outdir> [flags...] -> step window.recStep(i) and screenshot each frame
                                             into outdir
  bake <path?query> <outdir> [flags...] -> run a bake page and write its world files to outdir

For uncapped frame rates pass --disable-gpu-vsync --disable-frame-rate-limit.
"""

import asyncio
import functools
import http.server
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

import websockets

SESSION = [0]
# Throwaway Brave profiles go outside the repo (removed on exit; a killed run can leave one).
SCRATCH = os.environ.get('BENCH_PROFILE_DIR') or tempfile.gettempdir()
BRAVE = os.environ.get('BRAVE', '/opt/brave.com/brave/brave')


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    p = s.getsockname()[1]
    s.close()
    return p


def serve(root):
    port = free_port()

    class Q(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass

    h = functools.partial(Q, directory=root)
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', port), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, port


def pss_by_type(profile):
    out = {}
    for pid in os.listdir('/proc'):
        if not pid.isdigit():
            continue
        try:
            with open(f'/proc/{pid}/cmdline', 'rb') as f:
                cmd = f.read().replace(b'\0', b' ').split()
        except OSError:
            continue
        try:
            with open(f'/proc/{pid}/stat') as f:
                sid = int(f.read().rsplit(')', 1)[1].split()[3])
        except Exception:
            continue
        if sid != SESSION[0]:
            continue
        typ = 'browser'
        for c in cmd:
            if c.startswith(b'--type='):
                typ = c[7:].decode()
            if c.startswith(b'--utility-sub-type='):
                typ = 'util:' + c[19:].decode().split('.')[-1]
        try:
            with open(f'/proc/{pid}/smaps_rollup') as f:
                for line in f:
                    if line.startswith('Pss:'):
                        out[typ] = out.get(typ, 0) + int(line.split()[1]) / 1024
        except OSError:
            pass
    return out


def gpu_drm_mb():
    """GPU memory the session's gpu-process holds through DRM (fdinfo), in MB per region."""
    tot = {}
    for pid in os.listdir('/proc'):
        if not pid.isdigit():
            continue
        try:
            with open(f'/proc/{pid}/cmdline', 'rb') as f:
                if b'--type=gpu-process' not in f.read():
                    continue
            with open(f'/proc/{pid}/stat') as f:
                sid = int(f.read().rsplit(')', 1)[1].split()[3])
            if sid != SESSION[0]:
                continue
            seen = set()
            for fd in os.listdir(f'/proc/{pid}/fdinfo'):
                try:
                    with open(f'/proc/{pid}/fdinfo/{fd}') as f:
                        txt = f.read()
                except OSError:
                    continue
                if 'drm-client-id' not in txt:
                    continue
                cid = [ln for ln in txt.splitlines() if ln.startswith('drm-client-id')][0]
                if cid in seen:
                    continue
                seen.add(cid)
                for ln in txt.splitlines():
                    if 'memory' in ln and ':' in ln:
                        k, v = ln.split(':', 1)
                        parts = v.split()
                        mb = int(parts[0]) / (
                            1024 if parts[1:] == ['KiB'] else 1048576 if parts[1:] == [] else 1
                        )
                        tot[k] = round(tot.get(k, 0) + mb)
        except OSError:
            pass
    return tot


def mem_available():
    with open('/proc/meminfo') as f:
        for line in f:
            if line.startswith('MemAvailable:'):
                return int(line.split()[1]) / 1024


class CDP:
    def __init__(self, ws):
        self.ws, self.n, self.events = ws, 0, []

    async def call(self, method, **params):
        self.n += 1
        mid = self.n
        await self.ws.send(json.dumps({'id': mid, 'method': method, 'params': params}))
        while True:
            msg = json.loads(await self.ws.recv())
            if 'method' in msg and msg['method'] in (
                'Runtime.exceptionThrown',
                'Runtime.consoleAPICalled',
            ):
                self.events.append(msg)
            if msg.get('id') == mid:
                if 'error' in msg:
                    raise RuntimeError(msg['error'])
                return msg['result']

    async def ev(self, expr, timeout=180):
        r = await asyncio.wait_for(
            self.call('Runtime.evaluate', expression=expr, awaitPromise=True, returnByValue=True),
            timeout,
        )
        if 'exceptionDetails' in r:
            raise RuntimeError(
                r['exceptionDetails'].get('exception', {}).get('description', r['exceptionDetails'])
            )
        return r['result'].get('value')


PROBE_JS = r"""(async () => {
  const out = {};
  const c = document.createElement('canvas'); const gl = c.getContext('webgl2');
  if (gl) { const d = gl.getExtension('WEBGL_debug_renderer_info');
    out.webgl = d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); }
  out.compressed = gl
    ? gl.getSupportedExtensions().filter(e => /compress|multi_draw|clip_cull|float_blend/.test(e))
    : null;
  out.maxTex = gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : null;
  out.hasGPU = !!navigator.gpu;
  if (navigator.gpu) { try { const a = await navigator.gpu.requestAdapter();
      out.adapter = a ? {
        info: a.info
          ? {vendor: a.info.vendor, arch: a.info.architecture, desc: a.info.description}
          : null,
        fallback: a.isFallbackAdapter, features: [...a.features].length,
        maxBuf: a.limits.maxBufferSize,
        feat: [...a.features].filter(f => /texture-compression|timestamp|indirect/.test(f)),
      } : null;
      if (a) { const dev = await a.requestDevice(); out.device = !!dev; dev.destroy(); }
    } catch (e) { out.adapterErr = String(e); } }
  return out; })()"""

# Average requestAnimationFrame rate over 5 s.
FPS_SAMPLE_JS = """new Promise(res => {
  let n = 0;
  const t0 = performance.now();
  const f = () => {
    n++;
    if (performance.now() - t0 < 5000) requestAnimationFrame(f);
    else res(+(n / ((performance.now() - t0) / 1000)).toFixed(1));
  };
  requestAnimationFrame(f);
})"""

SHADOWS_OFF_JS = """
simulator.renderer.renderer.shadowMap.autoUpdate = true;
simulator.renderer.renderer.shadowMap.enabled = false;
simulator.renderer.scene.traverse(o => { if (o.material) o.material.needsUpdate = true });
1"""

RENDER_INFO_JS = """(() => {
  const r = window.simulator.renderer.renderer;
  const fps = document.getElementById('fps-counter').textContent;
  return {
    geometries: r.info.memory.geometries, textures: r.info.memory.textures,
    calls: r.info.render.calls, tris: r.info.render.triangles, fps,
  };
})()"""


async def fit_viewport(c, page):
    """Make the page viewport exactly the render size (?w=&h=) so captures are 1:1, not the
    headless window's default size with the canvas stretched into it."""
    from urllib.parse import parse_qs, urlparse

    q = parse_qs(urlparse(page).query)
    w, h = int(q.get('w', ['1280'])[0]), int(q.get('h', ['720'])[0])
    await c.call(
        'Emulation.setDeviceMetricsOverride', width=w, height=h, deviceScaleFactor=1, mobile=False
    )


async def run(repo, mode, args):
    srv, port = serve(repo)
    profile = tempfile.mkdtemp(prefix='brave-prof-', dir=SCRATCH)
    dport = free_port()
    flags = [a for a in args if a.startswith('--')]
    pos = [a for a in args if not a.startswith('--')]
    # Headless by default so a run never opens a window that takes keyboard/mouse focus.
    # --enable-gpu + --ignore-gpu-blocklist keeps it on the real GPU; without them headless
    # Brave falls back to SwiftShader and every number is meaningless. BENCH_HEADED=1 opts out.
    if os.environ.get('BENCH_HEADED') != '1' and not any(f.startswith('--headless') for f in flags):
        flags = ['--headless=new', '--enable-gpu', '--ignore-gpu-blocklist', *flags]
    cmd = [
        BRAVE,
        f'--user-data-dir={profile}',
        f'--remote-debugging-port={dport}',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--window-size=1280,720',
        '--autoplay-policy=no-user-gesture-required',
        *flags,
        'about:blank',
    ]
    proc = subprocess.Popen(
        cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True
    )
    SESSION[0] = proc.pid
    try:
        tab = None
        for _ in range(150):
            try:
                tabs = json.load(urllib.request.urlopen(f'http://127.0.0.1:{dport}/json'))
                tab = next((t for t in tabs if t['type'] == 'page'), None)
                if tab:
                    break
            except Exception:
                pass
            time.sleep(0.2)
        if not tab:
            raise RuntimeError('Brave exposed no page target')
        async with websockets.connect(tab['webSocketDebuggerUrl'], max_size=None) as ws:
            c = CDP(ws)
            await c.call('Runtime.enable')
            if mode == 'probe':
                await c.call('Page.navigate', url=f'http://127.0.0.1:{port}/index.html')
                await asyncio.sleep(2)
                print(json.dumps(await c.ev(PROBE_JS), indent=1))
                return
            mapname = pos[0]
            if mode == 'record':
                import base64

                await fit_viewport(c, pos[0])
                await c.call('Page.navigate', url=f'http://127.0.0.1:{port}/{pos[0]}')
                for _ in range(2400):
                    await asyncio.sleep(0.5)
                    try:
                        if await c.ev('!!window.benchResult', timeout=10):
                            break
                    except Exception:
                        pass
                    if any(e['method'] == 'Runtime.exceptionThrown' for e in c.events):
                        print(json.dumps({'error': [str(e)[:400] for e in c.events[:3]]}))
                        return
                n = (await c.ev('window.benchResult', timeout=10))['frames']
                outdir = pos[1]
                os.makedirs(outdir, exist_ok=True)
                for i in range(n):
                    await c.ev(f'window.recStep({i})', timeout=60)
                    img = await c.call('Page.captureScreenshot', format='jpeg', quality=92)
                    with open(os.path.join(outdir, f'f{i:04d}.jpg'), 'wb') as f:
                        f.write(base64.b64decode(img['data']))
                print(json.dumps({'outdir': outdir, 'frames': n}))
                return
            if mode == 'bake':
                import base64
                import gzip

                await c.call('Page.navigate', url=f'http://127.0.0.1:{port}/{pos[0]}')
                out = None
                for _ in range(2400):
                    await asyncio.sleep(0.5)
                    try:
                        if await c.ev('!!window.bakeOut', timeout=10):
                            out = await c.ev('window.bakeOut', timeout=120)
                            break
                    except Exception:
                        pass
                    if any(e['method'] == 'Runtime.exceptionThrown' for e in c.events):
                        break
                if not out:
                    print(
                        json.dumps(
                            {
                                'error': 'no bake output',
                                'events': [str(e)[:300] for e in c.events[:5]],
                            }
                        )
                    )
                    return
                outdir = pos[1]
                os.makedirs(outdir, exist_ok=True)
                names = {
                    'coreHeights': 'core.h16.gz',
                    'backHeights': 'backdrop.h16.gz',
                    'coreSplat': 'core.splat.gz',
                    'backSplat': 'backdrop.splat.gz',
                }
                sizes = {}
                for k, b in out['b64'].items():
                    raw = base64.b64decode(b)
                    # mtime=0 so the same world always produces byte-identical files
                    gz = gzip.compress(raw, compresslevel=9, mtime=0)
                    with open(os.path.join(outdir, names[k]), 'wb') as f:
                        f.write(gz)
                    sizes[names[k]] = [len(raw), len(gz)]
                meta = out['meta']
                meta['files'] = names
                with open(os.path.join(outdir, 'world.json'), 'w') as f:
                    f.write(json.dumps(meta, indent=1))
                print(json.dumps({'outdir': outdir, 'bakeMs': meta.get('bakeMs'), 'sizes': sizes}))
                return
            if mode == 'bench':
                if os.environ.get('BENCH_SHOT'):
                    await fit_viewport(c, pos[0])
                await c.call('Page.navigate', url=f'http://127.0.0.1:{port}/{pos[0]}')
                res = None
                for _ in range(600):
                    await asyncio.sleep(0.25)
                    try:
                        res = await c.ev('window.benchResult || null', timeout=10)
                    except Exception:
                        res = None
                    if res:
                        break
                    if any(e['method'] == 'Runtime.exceptionThrown' for e in c.events):
                        break
                errs = []
                for e in c.events:
                    p = e['params']
                    if e['method'] == 'Runtime.exceptionThrown':
                        errs.append(
                            p['exceptionDetails']
                            .get('exception', {})
                            .get('description', str(p['exceptionDetails']))[:400]
                        )
                    elif p.get('type') in ('error', 'warning'):
                        errs.append(
                            p['type']
                            + ': '
                            + ' '.join(
                                str(a.get('value', a.get('description', '')))[:300]
                                for a in p.get('args', [])
                            )
                        )
                if res:
                    try:
                        res['probe'] = await c.ev('window.probeInfo ? window.probeInfo() : null')
                        res['firstFrameMs'] = await c.ev('window.firstFrameMs ?? null')
                    except Exception as e:
                        res['probe'] = str(e)[:200]
                if res and os.environ.get('BENCH_MEM'):
                    # Settle, collect garbage, then PSS per process type and GPU (DRM) memory.
                    await asyncio.sleep(3)
                    await c.call('HeapProfiler.collectGarbage')
                    await asyncio.sleep(1)
                    pss = pss_by_type(profile)
                    res['mem'] = {
                        'pss_MB': {k: round(v) for k, v in pss.items()},
                        'pss_total_MB': round(sum(pss.values())),
                        'js_heap_MB': round(
                            (await c.call('Runtime.getHeapUsage'))['usedSize'] / 1048576, 1
                        ),
                        'gpu_drm_MB': gpu_drm_mb(),
                    }
                shot = os.environ.get('BENCH_SHOT')
                if shot and res:
                    import base64

                    img = await c.call('Page.captureScreenshot', format='png')
                    with open(shot, 'wb') as f:
                        f.write(base64.b64decode(img['data']))
                print(json.dumps({'result': res, 'flags': flags, 'console': errs[:8]}))
                return
            if mode == 'fps':
                await c.call('Page.navigate', url=f'http://127.0.0.1:{port}/index.html')
                for _ in range(100):
                    if await c.ev('!!window.simulator'):
                        break
                    await asyncio.sleep(0.2)
                await asyncio.sleep(1)

                g0 = gpu_drm_mb()
                await c.ev(f"window.simulator.start({json.dumps(pos[0])}).then(() => 'ok')")
                await asyncio.sleep(3)
                a = await c.ev(FPS_SAMPLE_JS)
                await c.ev('simulator.renderer.renderer.shadowMap.autoUpdate = false; 1')
                b = await c.ev(FPS_SAMPLE_JS)
                await c.ev(SHADOWS_OFF_JS)
                d = await c.ev(FPS_SAMPLE_JS)
                print(
                    json.dumps(
                        {
                            'map': pos[0],
                            'flags': flags,
                            'fps_shadows': a,
                            'fps_shadow_frozen': b,
                            'fps_no_shadows': d,
                            'gpu_drm_before_MB': g0,
                            'gpu_drm_after_MB': gpu_drm_mb(),
                        }
                    )
                )
                return
            base_avail = mem_available()
            await c.call('Page.navigate', url=f'http://127.0.0.1:{port}/index.html')
            for _ in range(100):
                if await c.ev('!!window.simulator'):
                    break
                await asyncio.sleep(0.2)
            await asyncio.sleep(2)
            menu = pss_by_type(profile)
            t0 = time.time()
            if mapname != 'menu':
                await c.ev(f"window.simulator.start({json.dumps(mapname)}).then(() => 'ok')")
            load_s = time.time() - t0
            # fly: arm and hold a climb-ish throttle by poking physics directly for a few seconds
            await asyncio.sleep(6)
            await c.ev('new Promise(r => setTimeout(r, 100))')
            await c.call('HeapProfiler.collectGarbage')
            await asyncio.sleep(1)
            heap = await c.call('Runtime.getHeapUsage')
            info = await c.ev(RENDER_INFO_JS)
            after = pss_by_type(profile)
            print(
                json.dumps(
                    {
                        'map': mapname,
                        'flags': flags,
                        'load_s': round(load_s, 2),
                        'jsHeapUsedMB': round(heap['usedSize'] / 2**20, 1),
                        'pssMenuMB': {k: round(v) for k, v in menu.items()},
                        'pssMenuTotal': round(sum(menu.values())),
                        'pssMB': {k: round(v) for k, v in after.items()},
                        'pssTotal': round(sum(after.values())),
                        'memAvailDropMB': round(base_avail - mem_available()),
                        'three': info,
                    },
                    indent=1,
                )
            )
    finally:
        os.killpg(proc.pid, 15)
        try:
            proc.wait(10)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, 9)
        srv.shutdown()
        shutil.rmtree(profile, ignore_errors=True)


if __name__ == '__main__':
    asyncio.run(run(sys.argv[1], sys.argv[2], sys.argv[3:]))
