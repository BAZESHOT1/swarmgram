import glob, re
f = sorted(glob.glob('/opt/swarmgram/web/_expo/static/js/web/entry-*.js'))[0]
with open(f) as h:
    text = h.read()

for mod in ['13', '476', '20', '136', '397']:
    m = re.search(r'\},' + mod + r',\[[^\]]*\]\);', text)
    if not m:
        print(mod, 'not found')
        continue
    start = m.start()
    head = text[max(0, start-1000):m.start()+90]
    print(f'--- module {mod} (tail) ---')
    print(head[-700:])
    print()
