'use client';

import React, { useState, useEffect } from 'react';
import { Spin, message } from 'antd';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';

export default function ShareClient({ token }: { token: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<'loading' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState('正在验证分享链接...');

  useEffect(() => {
    const verifyToken = async () => {
      try {
        const res = await api.get('/users/verifyShareToken', {
          params: { token },
        });

        if (res.data?.code === 200 && res.data.data?.token) {
          // 验证成功，存储 token 和用户信息到 localStorage（持久化登录）
          localStorage.setItem('token', res.data.data.token);
          localStorage.setItem('userInfo', JSON.stringify(res.data.data.userInfo));
          // 标记为通过分享链接登录（可选，用于UI提示）
          localStorage.setItem('shareLogin', '1');
          message.success('登录成功，正在跳转...');
          // 跳转到 dashboard
          setTimeout(() => router.push('/dashboard'), 500);
        } else {
          setStatus('error');
          setErrorMsg(res.data?.message || '分享链接无效');
        }
      } catch (e: any) {
        setStatus('error');
        setErrorMsg(e?.response?.data?.message || e?.message || '验证失败，请稍后重试');
      }
    };

    if (token) {
      verifyToken();
    } else {
      setStatus('error');
      setErrorMsg('缺少分享token');
    }
  }, [token, router]);

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'column',
      background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      color: '#fff',
    }}>
      {status === 'loading' ? (
        <>
          <Spin size="large" />
          <div style={{ marginTop: 24, fontSize: 16 }}>{errorMsg}</div>
        </>
      ) : (
        <>
          <div style={{ fontSize: 48, marginBottom: 16 }}>⚠</div>
          <div style={{ fontSize: 18, marginBottom: 24 }}>{errorMsg}</div>
          <button
            onClick={() => router.push('/login')}
            style={{
              padding: '8px 24px',
              fontSize: 14,
              border: '1px solid #fff',
              background: 'transparent',
              color: '#fff',
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            前往登录
          </button>
        </>
      )}
    </div>
  );
}
