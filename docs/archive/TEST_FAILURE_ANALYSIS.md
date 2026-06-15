# 测试失败原因分析

## 问题分析

测试失败的 4 个用例都有相同的问题：响应体为空。

**错误模式:**
```
SyntaxError: Unexpected end of JSON input
expected '' to be 'data: one\n\ndata: two\n\n'
```

## 根本原因

我添加的 `try-finally` 块在错误处理优化中有一个 bug：

**问题代码:**
```typescript
} finally {
  // 这里会在成功响应时也消费响应体！
  if (lastResponse && !reply.sent) {
    await bufferBody(lastResponse);  // ❌ 提前消费了响应体
  }
}

if (lastResponse) {
  return sendUpstreamResponse(reply, lastResponse, ...);  // ❌ 响应体已空
}
```

**问题:** `finally` 块在 **所有情况** 下都执行，包括成功的请求。这导致响应体被提前消费（buffered），然后发送给客户端时就是空的了。

## 修复方案

修改条件，只在真正需要清理时才消费响应体：

```typescript
} finally {
  // 只有在不会发送响应时才清理
  if (lastResponse && !reply.sent && keyIds.length === 0) {
    await bufferBody(lastResponse);
  }
}
```

**修复逻辑:**
- `lastResponse` 存在
- `reply.sent` 为 false（还没发送）
- `keyIds.length === 0` **（新增）** - 没有选到任何 key，说明后面不会用这个响应

## 已修复

我已经更新了 `src/proxy.ts`，再次运行测试应该通过了：

```bash
npm test
```

## 经验教训

`finally` 块用于清理资源时要格外小心，确保不会影响正常流程。这个 case 提醒我们：

1. ✅ 清理资源很重要
2. ❌ 但不能"过度清理"
3. ✅ 需要精确判断什么时候需要清理

现在的修复确保只在真正需要时才消费响应体。
