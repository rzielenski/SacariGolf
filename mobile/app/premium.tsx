import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Alert, TextInput } from 'react-native';
import { Stack, router } from 'expo-router';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { isPremium, premiumDaysLeft } from '../lib/premium';
import {
  purchaseStatus, getOfferings, purchasePackage, restorePurchases,
} from '../lib/purchases';
import { C, F } from '../lib/colors';
import { OrnamentTitle } from '../components/Flourish';

/**
 * Premium upgrade / status screen.
 *
 * Today no payment processor is wired up — the "Upgrade" button calls
 * /premium/checkout which returns 501. We surface that as a friendly
 * "coming soon" alert so the UI can be tested end-to-end.
 *
 * When Stripe / Apple IAP is integrated, swap the alert for the appropriate
 * checkout flow (open the returned checkout_url, or call IAP requestPurchase).
 */
export default function PremiumScreen() {
  const { user, refreshUser } = useAuth();
  const [catalog, setCatalog] = useState<{
    features: { id: string; name: string; blurb: string }[];
    plans: { id: string; name: string; price_cents: number; period: string; savings_pct?: number }[];
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedPlan, setSelectedPlan] = useState<string>('yearly');
  const [code, setCode] = useState('');
  const [redeeming, setRedeeming] = useState(false);
  // RevenueCat offerings — populated when the SDK is installed and a fetch
  // succeeds. Each offering exposes `availablePackages` (per-product details).
  const [offerings, setOfferings] = useState<any | null>(null);
  const [purchasing, setPurchasing] = useState(false);
  const iapAvailable = purchaseStatus() === 'available';

  useEffect(() => {
    api.premium.catalog()
      .then(setCatalog)
      .catch(() => { })
      .finally(() => setLoading(false));
    // Pull RC offerings if the SDK is installed. Failures are silent — we
    // fall back to the promo-code path automatically.
    if (iapAvailable) getOfferings().then(setOfferings).catch(() => { });
  }, [iapAvailable]);

  // Pick a package matching the selected plan id, prefer a substring match
  // (RC products usually look like "sg_yearly_999" etc).
  const findPackageFor = (planId: string) => {
    const pkgs = (offerings?.current?.availablePackages ?? []) as any[];
    return pkgs.find((p) => (p.product?.identifier ?? '').toLowerCase().includes(planId.toLowerCase()))
        ?? pkgs.find((p) => (p.identifier ?? '').toLowerCase().includes(planId.toLowerCase()))
        ?? null;
  };

  const onPurchase = async () => {
    const pkg = findPackageFor(selectedPlan);
    if (!pkg) {
      Alert.alert('Plan unavailable', 'That plan isn\'t configured in the App Store yet — try a promo code below.');
      return;
    }
    setPurchasing(true);
    try {
      const res = await purchasePackage(pkg);
      if (res.entitled) {
        await refreshUser?.();
        Alert.alert('Welcome to Premium 👑', 'Your purchase was successful.');
      } else if (res.error && res.error !== 'Cancelled') {
        Alert.alert('Purchase failed', res.error);
      }
    } finally { setPurchasing(false); }
  };

  const onRestore = async () => {
    const res = await restorePurchases();
    if (res.entitled) {
      await refreshUser?.();
      Alert.alert('Restored', 'Premium has been restored to this device.');
    } else {
      Alert.alert('Nothing to restore', res.error ?? 'No prior purchase found for this account.');
    }
  };

  const active = isPremium(user);
  const daysLeft = premiumDaysLeft(user);

  const onRedeem = async () => {
    const trimmed = code.trim();
    if (!trimmed) {
      Alert.alert('Code Required', 'Enter your promo code to unlock premium.');
      return;
    }
    setRedeeming(true);
    try {
      const result = await api.premium.redeem(trimmed);
      // Refresh the auth context so isPremium(user) flips immediately.
      await refreshUser?.();
      Alert.alert(
        'Welcome to Premium 👑',
        `Your ${result.label} access is active${result.premium_until ? ` until ${new Date(result.premium_until).toLocaleDateString()}` : ' for life'}.`,
      );
      setCode('');
    } catch (err: any) {
      const msg = err?.message?.includes('Invalid')
        ? 'That code isn\'t valid. Double-check the spelling and try again.'
        : err?.message ?? 'Something went wrong. Try again.';
      Alert.alert('Redemption Failed', msg);
    } finally {
      setRedeeming(false);
    }
  };

  return (
    <ScrollView
      style={s.container}
      contentContainerStyle={s.content}
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={{ title: 'Premium', headerStyle: { backgroundColor: C.bg }, headerTintColor: C.gold }} />

      {loading ? (
        <View style={{ paddingTop: 80, alignItems: 'center' }}>
          <ActivityIndicator color={C.gold} size="large" />
        </View>
      ) : (
        <>
          <View style={s.hero}>
            <Text style={s.crown}>👑</Text>
            <Text style={s.brand}>SACARI PREMIUM</Text>
            <Text style={s.tagline}>Unlock the full crest.</Text>
          </View>

          {active && (
            <View style={s.activeBanner}>
              <Text style={s.activeTitle}>
                {(user as any)?.premium_plan === 'open_beta'
                  ? '★  Premium is on us  ★'
                  : "You're a member."}
              </Text>
              <Text style={s.activeSub}>
                {(user as any)?.premium_plan === 'open_beta'
                  ? "As a thanks for being in our first 100 users, premium is on the house. Every paid feature below is unlocked, no card, no expiry. Enjoy."
                  : (daysLeft != null ? `${daysLeft} day${daysLeft === 1 ? '' : 's'} remaining` : 'Lifetime access')}
              </Text>
            </View>
          )}

          {/* Feature list */}
          <OrnamentTitle title="Included" align="center" />
          <View style={{ marginTop: 12, marginBottom: 20 }}>
            {catalog?.features.map((f) => (
              <View key={f.id} style={s.featureRow}>
                <Text style={s.checkmark}>✦</Text>
                <View style={{ flex: 1 }}>
                  <Text style={s.featureName}>{f.name}</Text>
                  <Text style={s.featureBlurb}>{f.blurb}</Text>
                </View>
              </View>
            ))}
          </View>

          {/* Plan picker — hidden during open beta so reviewers don't see
              priced subscriptions that aren't actually purchasable yet
              (App Store Guideline 2.1 / 3.1.1). Re-enabled automatically
              when OPEN_BETA_PREMIUM flips off server-side. */}
          {(user as any)?.premium_plan !== 'open_beta' && (
            <>
              <OrnamentTitle title="Choose Plan" align="center" />
              <View style={s.planRow}>
                {catalog?.plans.map((p) => {
                  const selected = selectedPlan === p.id;
                  const dollars = (p.price_cents / 100).toFixed(p.price_cents % 100 === 0 ? 0 : 2);
                  return (
                    <TouchableOpacity
                      key={p.id}
                      style={[s.planBox, selected && s.planBoxSelected]}
                      onPress={() => setSelectedPlan(p.id)}
                      activeOpacity={0.7}
                    >
                      {p.savings_pct != null && (
                        <View style={s.saveTag}>
                          <Text style={s.saveTagText}>SAVE {p.savings_pct}%</Text>
                        </View>
                      )}
                      <Text style={[s.planName, selected && { color: C.gold }]}>{p.name}</Text>
                      <Text style={[s.planPrice, selected && { color: C.gold }]}>${dollars}</Text>
                      <Text style={s.planPeriod}>per {p.period}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </>
          )}

          {/* Native IAP subscribe button — only when the RC SDK is installed
              AND offerings loaded successfully. Otherwise we silently fall
              through to the promo-code path below. */}
          {!active && iapAvailable && offerings?.current?.availablePackages?.length > 0 && (
            <TouchableOpacity
              style={[s.upgradeBtn, purchasing && { opacity: 0.6 }]}
              onPress={onPurchase}
              disabled={purchasing}
              activeOpacity={0.85}
            >
              {purchasing
                ? <ActivityIndicator color={C.bg} />
                : <Text style={s.upgradeBtnLabel}>UPGRADE NOW</Text>}
            </TouchableOpacity>
          )}
          {!active && iapAvailable && (
            <TouchableOpacity onPress={onRestore} style={{ alignSelf: 'center', padding: 10 }}>
              <Text style={{ color: C.textMuted, fontSize: 12 }}>Restore previous purchase</Text>
            </TouchableOpacity>
          )}

          {/* Promo-code redemption — interim unlock until payments ship.
              The plan picker above is preserved for layout/preview but
              has no effect on redemption today. */}
          {!active && (
            <View style={s.codeBox}>
              <Text style={s.codeLabel}>HAVE A PROMO CODE?</Text>
              <Text style={s.codeHint}>
                Premium isn't on sale yet. Enter a code from the team to unlock now.
              </Text>
              <TextInput
                style={s.codeInput}
                value={code}
                onChangeText={setCode}
                placeholder="ENTER CODE"
                placeholderTextColor={C.textMuted}
                autoCapitalize="characters"
                autoCorrect={false}
                maxLength={32}
                editable={!redeeming}
              />
              <TouchableOpacity
                style={[s.upgradeBtn, (redeeming || !code.trim()) && { opacity: 0.5 }]}
                onPress={onRedeem}
                disabled={redeeming || !code.trim()}
                activeOpacity={0.8}
              >
                {redeeming
                  ? <ActivityIndicator color={C.bg} />
                  : <Text style={s.upgradeBtnLabel}>REDEEM</Text>}
              </TouchableOpacity>
            </View>
          )}

          {active && (
            <View style={[s.upgradeBtn, { opacity: 0.6 }]}>
              <Text style={s.upgradeBtnLabel}>ALREADY A MEMBER</Text>
            </View>
          )}

          <Text style={s.fineprint}>
            {iapAvailable
              ? 'Subscriptions auto-renew until cancelled. Manage from your App Store / Play settings.'
              : 'Subscriptions aren\'t on sale yet — promo codes are the only way to unlock for now.'}
          </Text>

          <TouchableOpacity style={s.backBtn} onPress={() => router.back()}>
            <Text style={s.backLabel}>← Back</Text>
          </TouchableOpacity>
        </>
      )}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  content: { padding: 20, paddingBottom: 60 },

  hero: { alignItems: 'center', marginTop: 8, marginBottom: 24 },
  crown: { fontSize: 56, marginBottom: 8 },
  brand: { color: C.gold, fontFamily: F.serif, fontSize: 26, fontWeight: '900', letterSpacing: 1.5 },
  tagline: { color: C.textMuted, fontSize: 14, marginTop: 4, fontStyle: 'italic' },

  activeBanner: {
    backgroundColor: C.card, borderWidth: 1, borderColor: C.gold,
    borderRadius: 8, padding: 14, marginBottom: 20, alignItems: 'center',
  },
  activeTitle: { color: C.gold, fontWeight: '900', fontSize: 16 },
  activeSub: { color: C.textMuted, fontSize: 12, marginTop: 4 },

  featureRow: {
    flexDirection: 'row', alignItems: 'flex-start',
    padding: 14, backgroundColor: C.card, borderRadius: 6,
    borderWidth: 1, borderColor: C.border, marginBottom: 8,
  },
  checkmark: { color: C.gold, fontSize: 16, marginRight: 12, marginTop: 1 },
  featureName: { color: C.text, fontWeight: '800', fontSize: 14 },
  featureBlurb: { color: C.textMuted, fontSize: 12, marginTop: 3, lineHeight: 16 },

  planRow: { flexDirection: 'row', gap: 8, marginTop: 12, marginBottom: 20 },
  planBox: {
    flex: 1, backgroundColor: C.card, borderWidth: 1, borderColor: C.border,
    borderRadius: 8, paddingVertical: 16, paddingHorizontal: 8, alignItems: 'center',
    minHeight: 110,
  },
  planBoxSelected: { borderColor: C.gold, borderWidth: 2 },
  planName: { color: C.text, fontWeight: '800', fontSize: 13, letterSpacing: 0.6 },
  planPrice: { color: C.text, fontFamily: F.serif, fontSize: 24, fontWeight: '900', marginTop: 4 },
  planPeriod: { color: C.textMuted, fontSize: 10, marginTop: 2 },
  saveTag: {
    position: 'absolute', top: -8, backgroundColor: C.gold,
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 3,
  },
  saveTagText: { color: C.bg, fontWeight: '900', fontSize: 9, letterSpacing: 0.5 },

  upgradeBtn: {
    backgroundColor: C.gold, borderRadius: 8, paddingVertical: 16, alignItems: 'center',
  },
  upgradeBtnLabel: { color: C.bg, fontWeight: '900', fontSize: 16, letterSpacing: 1 },

  codeBox: {
    backgroundColor: C.card, borderWidth: 1, borderColor: C.gold + '66',
    borderRadius: 8, padding: 16, marginBottom: 12,
  },
  codeLabel: { color: C.gold, fontWeight: '900', fontSize: 12, letterSpacing: 1, marginBottom: 4 },
  codeHint: { color: C.textMuted, fontSize: 12, lineHeight: 16, marginBottom: 12 },
  codeInput: {
    borderWidth: 1, borderColor: C.border, borderRadius: 6,
    paddingVertical: 12, paddingHorizontal: 14, marginBottom: 12,
    color: C.text, fontFamily: F.serif, fontSize: 18, letterSpacing: 2,
    backgroundColor: C.bg, textAlign: 'center', fontWeight: '700',
  },

  fineprint: {
    color: C.textMuted, fontSize: 10, textAlign: 'center',
    marginTop: 16, lineHeight: 14, paddingHorizontal: 8,
  },
  backBtn: { marginTop: 24, alignSelf: 'center', padding: 10 },
  backLabel: { color: C.gold, fontSize: 14 },
});
