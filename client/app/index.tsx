import React, { useEffect } from 'react';
import { View } from 'react-native';
import { Redirect } from 'expo-router';
import { getSession, initSession, setSession } from '../src/data/api';
import { useStore } from '../src/state/useStore';

/** Входная точка: мгновенный редирект по восстановленной сессии. */
export default function Home() {
  const [resolved, setResolved] = React.useState(false);
  const hasSession = useStore((s) => s.session !== null);

  useEffect(() => {
    void (async () => {
      const s = getSession() ?? (await initSession());
      await setSession(s);
      useStore.getState().setSession(s);
      setResolved(true);
    })();
  }, []);

  if (!resolved) return <View style={{ flex: 1, backgroundColor: '#0A0E13' }} />;
  if (hasSession) return <Redirect href="/chats" />;
  return <Redirect href="/login" />;
}
