import React from 'react';
import { Text, View, StyleSheet } from 'react-native';

export function Card({ title, children, theme }: { title: string; children: React.ReactNode; theme?: unknown }) {
  void theme;
  return (
    <View style={[styles.card, {}]}>
      {title ? <Text style={styles.title}>{title}</Text> : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 12, padding: 16, gap: 8 },
  title: { fontWeight: '700', fontSize: 15 },
});
