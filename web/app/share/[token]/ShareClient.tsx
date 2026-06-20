'use client';

import React, { useState, useEffect } from 'react';
import { Spin, message } from 'antd';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';

export default function ShareClient({ token: propToken }: { token: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<'loading' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState('正在验证分享链接...');

  // 静态导出模式下，params.token 可能是预渲染的 placeholder，
  // 需要从 URL 中解析实际 token
  const actualToken = (() => {
    if (typeof window === 'undefined') return propToken;
    const pathParts = window.location.pathname.split('/');
    // /share/xxx → [' ', 'share', 'xxx']
    const urlToken = pathParts[2];
    return urlToken && urlToken !== 'placeholder' ? urlToken : propToken;
  })();

  // 从 URL query 读取用户名（仅用于加载提示展示，不影响鉴权）
  const urlUsername = (() => {
    if (typeof window === 'undefined') return '';
    const params = new URLSearchParams(window.location.search);
    return params.get('u') || '';
  })();

  useEffect(() => {
    const verifyToken = async () => {
      try {
        const res = await api.get('/users/verifyShareToken', {
          params: { token: actualToken },
        });

        if (res.data?.code === 200 && res.data.data?.token) {
          // 验证成功，存储 token 和用户信息到 localStorage（持久化登录）
          localStorage.setItem('token', res.data.data.token);
          localStorage.setItem('userInfo', JSON.stringify(res.data.data.userInfo));
          // 标记为通过分享链接登录（可选，用于UI提示）
          localStorage.setItem('shareLogin', '1');
          const displayName = res.data.data.userInfo?.username || urlUsername;
          message.success(displayName ? `${displayName} 的GEO报告加载成功，正在跳转...` : '登录成功，正在跳转...');
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

    if (actualToken && actualToken !== 'placeholder') {
      verifyToken();
    } else {
      setStatus('error');
      setErrorMsg('缺少分享token');
    }
  }, [actualToken, urlUsername, router]);

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
          <div style={{ marginTop: 24, fontSize: 16 }}>
            {urlUsername ? `正在加载 ${urlUsername} 的GEO报告...` : errorMsg}
          </div>
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
