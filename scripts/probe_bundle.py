import glob
f = sorted(glob.glob('/opt/swarmgram/web/_expo/static/js/web/entry-*.js'))[0]
with open(f) as h:
    text = h.read()
lines = text.split('\n')
line = lines[1017] if len(lines) > 1017 else ''
print('file:', f)
print('total lines:', len(lines))
print('line1018 len:', len(line))
print(line[3300:3950])
