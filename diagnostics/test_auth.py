#!/usr/bin/env python3
from werkzeug.security import generate_password_hash, check_password_hash
import os
from dotenv import load_dotenv
import json

def test_different_hash_methods():
    load_dotenv()
    
    app_password = os.getenv('APP_PASSWORD')
    if not app_password:
        print("ERROR: APP_PASSWORD not set")
        return
    
    methods = ['pbkdf2:sha256', 'sha256']
    results = {
        "original_password": app_password,
        "hash_tests": {}
    }
    
    for method in methods:
        test_hash = generate_password_hash(app_password, method=method)
        verification = check_password_hash(test_hash, app_password)
        
        results["hash_tests"][method] = {
            "hash": test_hash,
            "verification_success": verification,
            "hash_length": len(test_hash)
        }
    
    print("\nHash Method Tests:")
    print(json.dumps(results, indent=2))
    
    return results

if __name__ == "__main__":
    test_different_hash_methods()