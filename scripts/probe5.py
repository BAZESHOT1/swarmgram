import glob, re
f = sorted(glob.glob('/opt/swarmgram/web/_expo/static/js/web/entry-*.js'))[0]
with open(f) as h:
    text = h.read()
print('StyleSheet.create occurrences:', len(re.findall(r'StyleSheet\.create', text)))
# найти первое вхождение с контекстом определения
poses = [m.start() for m in re.finditer(r'StyleSheet', text)][:8]
for p in poses:
    print('----', p)
    print(text[p-60:p+120].replace('\n', ' '))
