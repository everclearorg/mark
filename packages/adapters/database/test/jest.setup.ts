// Jest setup file that runs before all tests
import { Client } from 'pg';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Global setup that runs once before all test suites
module.exports = async () => {
  // Connect to postgres database to create test database
  const client = new Client({
    host: 'localhost',
    port: 5433,
    user: 'postgres',
    password: 'postgres',
    database: 'postgres', // Connect to default postgres db
  });

  try {
    await client.connect();
    
    // Try to create database, ignore error if it already exists
    try {
      await client.query('CREATE DATABASE mark_test');
      console.log('Created test database: mark_test');
      
      // Run migrations on test database
      const testDbUrl = 'postgresql://postgres:postgres@localhost:5433/mark_test?sslmode=disable';
      await execAsync(`DATABASE_URL="${testDbUrl}" yarn db:migrate`);
      console.log('Ran migrations on test database');
    } catch (error: any) {
      // Database already exists, which is fine
      if (error.code !== '42P04') { // 42P04 is "database already exists"
        throw error;
      }
    }
  } catch (error) {
    console.error('Error setting up test database:', error);
    throw error;
  } finally {
    await client.end();
  }
};