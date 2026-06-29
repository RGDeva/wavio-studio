#!/usr/bin/env node

/**
 * Simple test script to verify MuseSDK integration
 */

const path = require('path');
const fs = require('fs');

console.log('Testing MuseSDK integration...');

try {
  // Test loading the native addon
  const addonPath = path.join(__dirname, 'native', 'musehub-sdk', 'mac', 'MuseClientSdk.node');
  
  if (!fs.existsSync(addonPath)) {
    console.error('❌ MuseSDK native addon not found at:', addonPath);
    process.exit(1);
  }

  console.log('✅ MuseSDK native addon found');
  
  const MuseSdk = require(addonPath);
  console.log('✅ MuseSDK loaded successfully');
  
  // Test initialization in test mode
  console.log('🔧 Testing SDK initialization in test mode...');
  const initResult = MuseSdk.initializeTestMode(true);
  
  if (initResult.status !== 0) {
    console.error('❌ SDK initialization failed, status:', initResult.status);
    process.exit(1);
  }
  
  console.log('✅ SDK initialized successfully, handle:', initResult.handle);
  
  // Test getUserInfo
  console.log('👤 Testing getUserInfo...');
  const userInfoResult = MuseSdk.getUserInfo(initResult.handle);
  
  if (userInfoResult.status !== 0) {
    console.error('❌ getUserInfo failed, status:', userInfoResult.status);
    process.exit(1);
  }
  
  console.log('✅ getUserInfo successful:');
  console.log('   UUID:', userInfoResult.userInfo.uuid);
  console.log('   Email:', userInfoResult.userInfo.email);
  console.log('   Name:', userInfoResult.userInfo.name);
  
  // Test getSku if available
  console.log('🏷️  Testing getSku...');
  const skuResult = MuseSdk.getSku(initResult.handle);
  if (skuResult.status === 0 && skuResult.sku) {
    console.log('✅ SKU:', skuResult.sku.sku);
  } else {
    console.log('⚠️  SKU not available (status:', skuResult.status, ')');
  }
  
  // Test getSubscriptionOption if available
  console.log('📋 Testing getSubscriptionOption...');
  const subResult = MuseSdk.getSubscriptionOption(initResult.handle);
  if (subResult.status === 0) {
    console.log('✅ Subscription option:', subResult.subscriptionOption.assignedId);
  } else {
    console.log('⚠️  Subscription option not available (status:', subResult.status, ')');
  }
  
  // Finalize
  console.log('🔚 Testing finalize...');
  const finalizeResult = MuseSdk.finalize(initResult.handle);
  console.log('✅ Finalized, status:', finalizeResult.status);
  
  console.log('\n🎉 All MuseSDK tests passed!');
  
} catch (err) {
  console.error('❌ Test failed:', err.message);
  console.error(err.stack);
  process.exit(1);
}
