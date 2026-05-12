import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { C, F } from '../lib/colors';

/**
 * Catches render-time exceptions anywhere in the tree below it and shows a
 * recoverable "something went wrong" panel instead of the white-screen state
 * the user would otherwise see. Without this, an uncaught error in a single
 * screen blanks the whole app and forces a full kill-and-relaunch.
 *
 * Recovery is two-tiered:
 *   • "Try again" remounts the children by bumping `resetKey`. Fixes most
 *     transient errors (e.g. stale prop after navigation, network race).
 *   • If the same error fires again immediately, the panel stays up — the
 *     user can read the message and either reload manually or close out.
 *
 * React error boundaries only catch errors thrown during render / lifecycle.
 * Async / event-handler errors still need their own try-catch elsewhere.
 */
type Props = { children: React.ReactNode };
type State = { error: Error | null; resetKey: number };

export class AppErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, resetKey: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Surface to the metro console in dev so the trace is searchable.
    // eslint-disable-next-line no-console
    console.error('[AppErrorBoundary]', error, info.componentStack);
  }

  reset = () => {
    this.setState((s) => ({ error: null, resetKey: s.resetKey + 1 }));
  };

  render() {
    if (this.state.error) {
      return (
        <View style={s.container}>
          <Text style={s.title}>Something went wrong</Text>
          <Text style={s.subtitle}>
            The app hit an unexpected error. Tap below to try again — if it keeps
            happening, close the app fully and reopen.
          </Text>
          <ScrollView style={s.errBox} contentContainerStyle={{ padding: 12 }}>
            <Text style={s.errText}>{String(this.state.error?.message ?? this.state.error)}</Text>
          </ScrollView>
          <TouchableOpacity style={s.btn} onPress={this.reset} activeOpacity={0.8}>
            <Text style={s.btnText}>Try Again</Text>
          </TouchableOpacity>
        </View>
      );
    }
    // The resetKey forces a fresh subtree mount on retry — components that
    // crashed with stale internal state get a clean start.
    return <React.Fragment key={this.state.resetKey}>{this.props.children}</React.Fragment>;
  }
}

const s = StyleSheet.create({
  container: {
    flex: 1, backgroundColor: C.bg,
    alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 24, paddingVertical: 40,
  },
  title: { color: C.gold, fontFamily: F.serif, fontSize: 26, fontWeight: '900', marginBottom: 14, textAlign: 'center' },
  subtitle: { color: C.text, fontSize: 14, lineHeight: 20, textAlign: 'center', marginBottom: 24 },
  errBox: {
    maxHeight: 160, alignSelf: 'stretch',
    backgroundColor: C.card, borderRadius: 6,
    borderWidth: 1, borderColor: C.border, marginBottom: 24,
  },
  errText: { color: C.textMuted, fontSize: 12, fontFamily: 'Courier' },
  btn: {
    backgroundColor: C.gold, paddingVertical: 14, paddingHorizontal: 32,
    borderRadius: 6,
  },
  btnText: { color: C.bg, fontWeight: '900', fontSize: 15, letterSpacing: 1 },
});
