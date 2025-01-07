#!/usr/bin/env python3
from werkzeug.security import generate_password_hash, check_password_hash
import os
from dotenv import load_dotenv
import json

def verify_env():
    load_dotenv()
    
    results = {
        "environment_variables": {},
        "hash_verification": {},
        "test_results": {}
    }
    
    # Get environment variables
    app_password = os.getenv('APP_PASSWORD')
    stored_hash = os.getenv('PASSWORD_HASH')
    secret_key = os.getenv('SECRET_KEY')
    
    # Check APP_PASSWORD
    results["environment_variables"]["APP_PASSWORD"] = {
        "is_set": bool(app_password),
        "length": len(app_password) if app_password else 0
    }
    
    # Check PASSWORD_HASH
    results["environment_variables"]["PASSWORD_HASH"] = {
        "is_set": bool(stored_hash),
        "length": len(stored_hash) if stored_hash else 0
    }
    
    # Check SECRET_KEY
    results["environment_variables"]["SECRET_KEY"] = {
        "is_set": bool(secret_key),
        "length": len(secret_key) if secret_key else 0
    }
    
    # Test hash verification
    if app_password and stored_hash:
        # Test stored hash
        results["hash_verification"]["stored_hash"] = {
            "verification_success": check_password_hash(stored_hash, app_password)
        }
        
        # Generate new hash and test
        new_hash = generate_password_hash(app_password)
        results["hash_verification"]["new_hash"] = {
            "verification_success": check_password_hash(new_hash, app_password),
            "hash": new_hash
        }
        
        # Compare hashes
        results["hash_verification"]["hash_comparison"] = {
            "match": stored_hash == new_hash,
            "stored_hash_method": stored_hash.split('$')[0] if stored_hash else None,
            "new_hash_method": new_hash.split('$')[0]
        }
    
    # Print results
    print("\nDiagnostic Results:")
    print(json.dumps(results, indent=2))
    
    return results

if __name__ == "__main__":
    verify_env()