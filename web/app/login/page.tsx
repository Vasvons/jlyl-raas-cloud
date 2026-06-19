'use client';

import React, { useState, useEffect } from 'react';
import { Card, Input, Button, Form, message, Modal, Tabs } from 'antd';
import { UserOutlined, LockOutlined, CloudOutlined } from '@ant-design/icons';
import api from '@/lib/api';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const [loading, setLoading] = useState(false);
  const [cloudModalVisible, setCloudModalVisible] = useState(false);
  const [cloudLoading, setCloudLoading] = useState(false);
  const [cloudForm] = Form.useForm();
  const [hasCloudConfig, setHasCloudConfig] = useState<boolean | null>(null);
  const router = useRouter();

  // 检查云端配置是否已设置
  useEffect(() => {
    (async () => {
      try {
        // 尝试调用一个需要云端配置的API来检测
        const res = await api.get('/users/getLoginUser');
        if (res.data?.code === 403) {
          setHasCloudConfig(false);
        } else {
          setHasCloudConfig(true);
        }
      } catch {
        setHasCloudConfig(false);
      }
    })();
  }, []);

  const onFinish = async (values: { username: string; password: string }) => {
    setLoading(true);
    try {
      const res = await api.post('/users/login', values);
      if (res.data?.code === 200) {
        const { token, userInfo } = res.data.data;
        localStorage.setItem('token', token);
        localStorage.setItem('userInfo', JSON.stringify(userInfo));
        message.success('登录成功');
        router.push('/dashboard');
      } else {
        message.error(res.data?.message || '登录失败');
      }
    } catch (e) {
      message.error('登录失败，请重试');
    } finally {
      setLoading(false);
    }
  };

  // 保存云端配置
  const onCloudConfigSave = async (values: any) => {
    setCloudLoading(true);
    try {
      // 直接调用云端登录接口来验证配置
      const res = await api.post('/users/login', {
        username: values.username,
        password: values.password,
        cloudUrl: values.cloudUrl,
      });
      if (res.data?.code === 200) {
        message.success('云端配置成功');
        setHasCloudConfig(true);
        setCloudModalVisible(false);
        cloudForm.resetFields();
      } else {
        message.error(res.data?.message || '配置失败，请检查云端地址和凭据');
      }
    } catch (e) {
      message.error('配置失败，请检查网络连接');
    } finally {
      setCloudLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      position: 'relative',
    }}>
      {/* 右上角云端配置按钮 - 固定位置，更显眼 */}
      <Button
        type={hasCloudConfig === false ? 'primary' : 'default'}
        icon={<CloudOutlined />}
        onClick={() => setCloudModalVisible(true)}
        style={{
          position: 'absolute',
          top: 24,
          right: 24,
          boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
        }}
      >
        云端配置{hasCloudConfig === false ? '（未配置）' : hasCloudConfig === true ? '（已连接）' : ''}
      </Button>

      <Card
        style={{ width: 400, boxShadow: '0 8px 24px rgba(0,0,0,0.15)' }}
        headStyle={{ textAlign: 'center', fontSize: 20, fontWeight: 600 }}
        title="聚量引力 RaaS"
      >
        {hasCloudConfig === false && (
          <div style={{ marginBottom: 16, padding: 12, background: '#fff7e6', border: '1px solid #ffd591', borderRadius: 4, fontSize: 13, color: '#ad6800' }}>
            <CloudOutlined /> 未配置云端服务，请点击右上角「云端配置」按钮配置云端连接
          </div>
        )}
        {hasCloudConfig === true && (
          <div style={{ marginBottom: 16, padding: 12, background: '#f6ffed', border: '1px solid #b7eb8f', borderRadius: 4, fontSize: 13, color: '#389e0d' }}>
            <CloudOutlined /> 云端已连接
          </div>
        )}
        <Form onFinish={onFinish} size="large">
          <Form.Item name="username" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input prefix={<UserOutlined />} placeholder="用户名" />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password prefix={<LockOutlined />} placeholder="密码" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={loading} block>
              登录
            </Button>
          </Form.Item>
        </Form>
      </Card>

      <Modal
        title="云端服务配置"
        open={cloudModalVisible}
        onCancel={() => setCloudModalVisible(false)}
        footer={null}
        width={450}
      >
        <Form form={cloudForm} layout="vertical" onFinish={onCloudConfigSave}>
          <Form.Item
            label="云端服务地址"
            name="cloudUrl"
            rules={[{ required: true, message: '请输入云端服务地址' }]}
            extra="例如: https://api.jlyl.net.cn 或 http://192.168.1.100:3002"
          >
            <Input prefix={<CloudOutlined />} placeholder="https://your-cloud-server.com" />
          </Form.Item>
          <Form.Item
            label="管理员用户名"
            name="username"
            rules={[{ required: true, message: '请输入管理员用户名' }]}
          >
            <Input placeholder="管理员用户名" />
          </Form.Item>
          <Form.Item
            label="管理员密码"
            name="password"
            rules={[{ required: true, message: '请输入管理员密码' }]}
          >
            <Input.Password placeholder="管理员密码" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={cloudLoading} block>
              保存并测试连接
            </Button>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
