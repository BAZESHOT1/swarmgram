import { readFileSync, writeFileSync } from 'node:fs';
const path = 'app/(app)/chats.tsx';
let text = readFileSync(path, 'utf8');
const start = text.indexOf('      <View style={styles.header}>');
const endMarker = '\n\n      {selecting ?';
const end = text.indexOf(endMarker, start);
if (start < 0 || end < 0) throw new Error('header markers not found');
const header = `      <View style={styles.header}>
        <Reanimated.View style={[styles.headerTitle, headerTitleStyle]}>
          <Text style={styles.headerTitleText}>Чаты</Text>
        </Reanimated.View>
        <View
          ref={searchHostRef}
          nativeID="sg-chats-search"
          style={styles.searchHost}
          onLayout={(e) => {
            const h = e.nativeEvent?.layout?.height ?? 0;
            if (h > 0 && Math.abs(h - searchHeight) > 0.5) setSearchHeight(h);
            measureSearch();
          }}
        >
          <SearchField
            ref={searchRef}
            value={search}
            expanded={searchExpanded}
            onChange={(t) => {
              setSearch(t);
              setFilter('all');
            }}
            onClear={clearSearch}
            onClose={collapseSearch}
            onFocus={() => {
              if (blurTimer.current) clearTimeout(blurTimer.current);
              setSearchFocused(true);
              setSearchHiddenAnimated(false);
            }}
            onBlur={() => {
              if (blurTimer.current) clearTimeout(blurTimer.current);
              blurTimer.current = setTimeout(() => setSearchFocused(false), 160);
            }}
            onSubmit={() => {
              if (selectedKey) {
                const row = selectableRows.find((r) => rowKey(r) === selectedKey);
                if (row) openSearchRow(row);
              } else {
                rememberQuery(search);
              }
            }}
            placeholder="Поиск"
          />
          {historyOpen ? (
            <View style={styles.headerHistory}>
              <SearchHistoryPanel
                theme={theme}
                wide={wide}
                history={history}
                onOpen={(entry) => {
                  setSearchFocused(false);
                  openHistoryEntry(entry);
                }}
                onRemove={(entry) => {
                  persistHistory(historyRef.current.filter((x) => !(x.type === entry.type && x.id === entry.id)));
                }}
                onClear={() => persistHistory([])}
              />
            </View>
          ) : null}
        </View>
        <Reanimated.View style={[styles.headerCreate, headerCreateStyle]}>
          <HeaderCreateMenu />
        </Reanimated.View>
      </View>`;
text = text.slice(0, start) + header + text.slice(end);
writeFileSync(path, text, 'utf8');
console.log('header replaced');
