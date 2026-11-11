import glob, re
f = sorted(glob.glob('/opt/swarmgram/web/_expo/static/js/web/entry-*.js'))[0]
with open(f) as h:
    text = h.read()
print('react-native-web literal:', text.find('react-native-web'))
print('framer literal:', text.find('framer-motion'))

# определить deps для модуля с StyleSheet.create (позиция 1439:3469)
lines = text.split('\n')
line = lines[1438] if len(lines) > 1438 else ''
print('line1439 len:', len(line))
print(line[3400:4000])
