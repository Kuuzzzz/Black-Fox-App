import sys
src, out = sys.argv[1], sys.argv[2]
h = open(src, encoding='utf-8').read()
def rep(a, b, n=1):
    global h
    c = h.count(a)
    assert c == n, (c, a[:90])
    h = h.replace(a, b)
# load the bridge before the app script, plus install bits
rep('<title>Black Fox Center</title>\n',
    '<title>Black Fox Center</title>\n<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials">\n<meta name="theme-color" content="#05070A">\n<script src="/bridge.js"></script>\n')
# wording that pointed at claude.ai
rep("return 'Add ' + server + ' in claude.ai Settings → Connectors to see this here.';", "return 'Connect your Google account (the Connect Google bar at the top) to see ' + server + ' here.';")
rep("return 'Your ' + server + ' sign-in expired. Reconnect it in claude.ai Settings → Connectors.';", "return 'Your Google connection expired. Press Connect Google at the top to reconnect.';")
rep("return 'Connectors are not available in this view. Open the app on claude.ai.';", "return 'Google is not connected yet. Press Connect Google at the top.';")
rep("toast('Saving is not available in this view. Open the app on claude.ai.', true);", "toast('Saving is not available right now. Reload the page.', true);")
rep("return 'Your claude.ai sign-in expired. Reload the page.';", "return 'Your sign-in expired. Reload the page.';")
rep("return 'Claude is not available in this view. Open the app on claude.ai.';", "return 'Claude writing is not switched on for you. Ask Heng.';")
rep("toast('Claude is not available in this view. Open the app on claude.ai.', true);", "toast('Claude writing is not switched on for you. Ask Heng.', true);")
rep("Claude is not available in this view, so steps cannot be written here. Open the app on claude.ai.", "Claude writing is not switched on yet, so steps cannot be written here. Add the Anthropic key in Cloudflare (see SETUP.md).")
rep("S.dbError = 'Open this app on claude.ai to load your projects.';", "S.dbError = 'Could not start the app. Reload the page.';")
rep("S.dbError = 'Saved projects are not available in this view. Open the app on claude.ai.';", "S.dbError = 'Saved projects are not available right now. Reload the page.';")
rep("APP_URL = 'https://claude.ai/artifact/Q7yfZ2q5PPjYwzKdyHEmAt';", "APP_URL = location.origin + '/';")
open(out, 'w', encoding='utf-8').write(h)
left = [l for l in h.split('\n') if 'claude.ai' in l]
print('remaining claude.ai mentions:', len(left))
for l in left: print('  ', l[:160])

# proper <head> (the claude.ai copy has its head wrapped inside <body>)
marker = '<meta name="claude:viewport-fit-sides" content="cover">\n'
i = h.index(marker) + len(marker)
head = '''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Black Fox Center</title>
<meta name="theme-color" content="#05070A">
<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/png" href="/icons/fox-192.png">
<link rel="apple-touch-icon" href="/icons/fox-180.png">
<style>body{margin:0}img{max-width:100%}[hidden]:not([hidden=until-found i]){display:none!important}</style>
<script src="/bridge.js"></script>
</head>
<body>
'''
h = head + h[i:]
assert h.count('<title>') == 1 and h.count('bridge.js') == 1
open(out, 'w', encoding='utf-8').write(h)
print('built', out, len(h))
