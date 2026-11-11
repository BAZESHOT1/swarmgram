import glob, re
f = sorted(glob.glob('/opt/swarmgram/web/_expo/static/js/web/entry-*.js'))[0]
with open(f) as h:
    text = h.read()

# module 15 head
idx = text.find('__d(function(g,r,i,a,m,e,d){},15,[')  # точный паттерн нам не известен
m = re.search(r'\},15,\[', text)
if m:
    start = max(0, m.start()-900)
    snippet = text[start:m.start()+80]
    print('module 15 head ----')
    print(snippet[-980:])
