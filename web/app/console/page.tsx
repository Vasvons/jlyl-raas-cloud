'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function ConsolePage() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/console/users');
  }, [router]);

  return (
    <div style={{ padding: 24, textAlign: 'center', color: '#999' }}>
      正在跳转到用户管理...
    </div>
  );
}
