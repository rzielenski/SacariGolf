import { Stack } from 'expo-router';

export default function AuthLayout() {
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#091409' } }}>
      <Stack.Screen name="login" />
    </Stack>
  );
}
