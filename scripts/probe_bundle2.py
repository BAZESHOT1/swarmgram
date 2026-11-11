import glob, re
f = sorted(glob.glob('/opt/swarmgram/web/_expo/static/js/web/entry-*.js'))[0]
with open(f) as h:
    text = h.read()

# Сколько раз встречаются системные сигнатуры
for marker in ['react-native-web', 'framer-motion', 'react-native-reanimated', 'StyleSheet.create({input:{borderWidth:1']:
    idx = text.find(marker)
    print(marker, '->', idx)

# dep map: найдём модуль 1357 и что такое d[2] (deps[2]=415) — покажем начало модуля 1357
m = re.search(r'\}\)\((.*?)\),1357,\[(.*?)\]\);', text)
if m:
    print('module 1357 found')
    deps = m.group(2)
    print('deps:', deps)

# Что за модуль 415? найдём его определение
m415 = re.search(r'\},415,\[(.*?)\]\);', text)
if m415:
    start = m415.start()
    snippet = text[max(0, start-700):start+120]
    print('--- module 415 head ---')
    print(snippet[-820:])
