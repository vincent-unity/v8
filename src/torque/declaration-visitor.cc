// Copyright 2017 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#include "src/torque/declaration-visitor.h"

#include "src/torque/ast.h"
#include "src/torque/server-data.h"
#include "src/torque/type-visitor.h"

namespace v8 {
namespace internal {
namespace torque {

Namespace* GetOrCreateNamespace(const std::string& name) {
  std::vector<Namespace*> existing_namespaces = FilterDeclarables<Namespace>(
      Declarations::TryLookupShallow(QualifiedName(name)));
  if (existing_namespaces.empty()) {
    return Declarations::DeclareNamespace(name);
  }
  DCHECK_EQ(1, existing_namespaces.size());
  return existing_namespaces.front();
}

void TypeDeclarationVisitor::Predeclare(Declaration* decl) {
  CurrentSourcePosition::Scope scope(decl->pos);
  switch (decl->kind) {
#define ENUM_ITEM(name)        \
  case AstNode::Kind::k##name: \
    return Predeclare(name::cast(decl));
    AST_TYPE_DECLARATION_NODE_KIND_LIST(ENUM_ITEM)
#undef ENUM_ITEM
    case AstNode::Kind::kNamespaceDeclaration:
      return Predeclare(NamespaceDeclaration::cast(decl));
    default:
      // This visitor only processes type declaration nodes.
      break;
  }
}

void DeclarationVisitor::Visit(Declaration* decl) {
  CurrentSourcePosition::Scope scope(decl->pos);
  switch (decl->kind) {
#define ENUM_ITEM(name)        \
  case AstNode::Kind::k##name: \
    return Visit(name::cast(decl));
    AST_DECLARATION_NODE_KIND_LIST(ENUM_ITEM)
#undef ENUM_ITEM
    default:
      UNIMPLEMENTED();
  }
}

void DeclarationVisitor::Visit(CallableNode* decl, const Signature& signature,
                               base::Optional<Statement*> body) {
  switch (decl->kind) {
#define ENUM_ITEM(name)        \
  case AstNode::Kind::k##name: \
    return Visit(name::cast(decl), signature, body);
    AST_CALLABLE_NODE_KIND_LIST(ENUM_ITEM)
#undef ENUM_ITEM
    default:
      UNIMPLEMENTED();
  }
}

Builtin* DeclarationVisitor::CreateBuiltin(BuiltinDeclaration* decl,
                                           std::string external_name,
                                           std::string readable_name,
                                           Signature signature,
                                           base::Optional<Statement*> body) {
  const bool javascript = decl->javascript_linkage;
  const bool varargs = decl->signature->parameters.has_varargs;
  Builtin::Kind kind = !javascript ? Builtin::kStub
                                   : varargs ? Builtin::kVarArgsJavaScript
                                             : Builtin::kFixedArgsJavaScript;

  if (signature.types().size() == 0 ||
      !(signature.types()[0] ==
        Declarations::LookupGlobalType(CONTEXT_TYPE_STRING))) {
    std::stringstream stream;
    stream << "first parameter to builtin " << decl->name
           << " is not a context but should be";
    ReportError(stream.str());
  }

  if (varargs && !javascript) {
    std::stringstream stream;
    stream << "builtin " << decl->name
           << " with rest parameters must be a JavaScript builtin";
    ReportError(stream.str());
  }

  if (javascript) {
    if (signature.types().size() >= 2 &&
        !(signature.types()[1] ==
          Declarations::LookupGlobalType(OBJECT_TYPE_STRING))) {
      std::stringstream stream;
      stream << "second parameter to javascript builtin " << decl->name
             << " is " << *signature.types()[1] << " but should be Object";
      ReportError(stream.str());
    }
  }

  for (size_t i = 0; i < signature.types().size(); ++i) {
    if (const StructType* type =
            StructType::DynamicCast(signature.types()[i])) {
      std::stringstream stream;
      stream << "builtin '" << decl->name << "' uses the struct '"
             << type->name() << "' as argument '"
             << signature.parameter_names[i] << "'. This is not supported.";
      ReportError(stream.str());
    }
  }

  if (const StructType* struct_type =
          StructType::DynamicCast(signature.return_type)) {
    std::stringstream stream;
    stream << "builtins (in this case " << decl->name
           << ") cannot return structs (in this case " << struct_type->name()
           << ")";
    ReportError(stream.str());
  }

  return Declarations::CreateBuiltin(
      std::move(external_name), std::move(readable_name), kind,
      std::move(signature), decl->transitioning, body);
}

void DeclarationVisitor::Visit(ExternalRuntimeDeclaration* decl,
                               const Signature& signature,
                               base::Optional<Statement*> body) {
  if (GlobalContext::verbose()) {
    std::cout << "found declaration of external runtime " << decl->name
              << " with signature ";
  }

  if (signature.parameter_types.types.size() == 0 ||
      !(signature.parameter_types.types[0] ==
        Declarations::LookupGlobalType(CONTEXT_TYPE_STRING))) {
    std::stringstream stream;
    stream << "first parameter to runtime " << decl->name
           << " is not a context but should be";
    ReportError(stream.str());
  }

  if (signature.return_type->IsStructType()) {
    std::stringstream stream;
    stream << "runtime functions (in this case" << decl->name
           << ") cannot return structs (in this case "
           << static_cast<const StructType*>(signature.return_type)->name()
           << ")";
    ReportError(stream.str());
  }

  Declarations::DeclareRuntimeFunction(decl->name, signature,
                                       decl->transitioning);
}

void DeclarationVisitor::Visit(ExternalMacroDeclaration* decl,
                               const Signature& signature,
                               base::Optional<Statement*> body) {
  if (GlobalContext::verbose()) {
    std::cout << "found declaration of external macro " << decl->name
              << " with signature ";
  }

  Declarations::DeclareMacro(decl->name, decl->external_assembler_name,
                             signature, decl->transitioning, body, decl->op);
}

void DeclarationVisitor::Visit(TorqueBuiltinDeclaration* decl,
                               const Signature& signature,
                               base::Optional<Statement*> body) {
  Declarations::Declare(
      decl->name, CreateBuiltin(decl, decl->name, decl->name, signature, body));
}

void DeclarationVisitor::Visit(TorqueMacroDeclaration* decl,
                               const Signature& signature,
                               base::Optional<Statement*> body) {
  Macro* macro =
      Declarations::DeclareMacro(decl->name, base::nullopt, signature,
                                 decl->transitioning, body, decl->op);
  // TODO(szuend): Set identifier_position to decl->name->pos once all callable
  // names are changed from std::string to Identifier*.
  macro->SetPosition(decl->pos);
}

void DeclarationVisitor::Visit(IntrinsicDeclaration* decl,
                               const Signature& signature,
                               base::Optional<Statement*> body) {
  Declarations::DeclareIntrinsic(decl->name, signature);
}

void DeclarationVisitor::Visit(ConstDeclaration* decl) {
  Declarations::DeclareNamespaceConstant(
      decl->name, TypeVisitor::ComputeType(decl->type), decl->expression);
}

void DeclarationVisitor::Visit(StandardDeclaration* decl) {
  Signature signature =
      TypeVisitor::MakeSignature(decl->callable->signature.get());
  Visit(decl->callable, signature, decl->body);
}

void DeclarationVisitor::Visit(GenericDeclaration* decl) {
  Declarations::DeclareGeneric(decl->callable->name, decl);
}

void DeclarationVisitor::Visit(SpecializationDeclaration* decl) {
  if ((decl->body != nullptr) == decl->external) {
    std::stringstream stream;
    stream << "specialization of " << decl->name
           << " must either be marked 'extern' or have a body";
    ReportError(stream.str());
  }

  std::vector<Generic*> generic_list = Declarations::LookupGeneric(decl->name);
  // Find the matching generic specialization based on the concrete parameter
  // list.
  Generic* matching_generic = nullptr;
  Signature signature_with_types =
      TypeVisitor::MakeSignature(decl->signature.get());
  for (Generic* generic : generic_list) {
    Signature generic_signature_with_types =
        MakeSpecializedSignature(SpecializationKey{
            generic, TypeVisitor::ComputeTypeVector(decl->generic_parameters)});
    if (signature_with_types.HasSameTypesAs(generic_signature_with_types,
                                            ParameterMode::kIgnoreImplicit)) {
      if (matching_generic != nullptr) {
        std::stringstream stream;
        stream << "specialization of " << decl->name
               << " is ambigous, it matches more than one generic declaration ("
               << *matching_generic << " and " << *generic << ")";
        ReportError(stream.str());
      }
      matching_generic = generic;
    }
  }

  if (matching_generic == nullptr) {
    std::stringstream stream;
    if (generic_list.size() == 0) {
      stream << "no generic defined with the name " << decl->name;
      ReportError(stream.str());
    }
    stream << "specialization of " << decl->name
           << " doesn't match any generic declaration\n";
    stream << "specialization signature:";
    stream << "\n  " << signature_with_types;
    stream << "\ncandidates are:";
    for (Generic* generic : generic_list) {
      stream << "\n  "
             << MakeSpecializedSignature(SpecializationKey{
                    generic,
                    TypeVisitor::ComputeTypeVector(decl->generic_parameters)});
    }
    ReportError(stream.str());
  }

  Specialize(SpecializationKey{matching_generic, TypeVisitor::ComputeTypeVector(
                                                     decl->generic_parameters)},
             matching_generic->declaration()->callable, decl->signature.get(),
             decl->body);
}

void DeclarationVisitor::Visit(ExternConstDeclaration* decl) {
  const Type* type = TypeVisitor::ComputeType(decl->type);
  if (!type->IsConstexpr()) {
    std::stringstream stream;
    stream << "extern constants must have constexpr type, but found: \""
           << *type << "\"\n";
    ReportError(stream.str());
  }

  Declarations::DeclareExternConstant(decl->name, type, decl->literal);
}

void DeclarationVisitor::Visit(CppIncludeDeclaration* decl) {
  GlobalContext::AddCppInclude(decl->include_path);
}

void DeclarationVisitor::DeclareSpecializedTypes(const SpecializationKey& key) {
  size_t i = 0;
  const std::size_t generic_parameter_count =
      key.generic->declaration()->generic_parameters.size();
  if (generic_parameter_count != key.specialized_types.size()) {
    std::stringstream stream;
    stream << "Wrong generic argument count for specialization of \""
           << key.generic->name() << "\", expected: " << generic_parameter_count
           << ", actual: " << key.specialized_types.size();
    ReportError(stream.str());
  }

  for (auto type : key.specialized_types) {
    Identifier* generic_type_name =
        key.generic->declaration()->generic_parameters[i++];
    Declarations::DeclareType(generic_type_name, type);
  }
}

Signature DeclarationVisitor::MakeSpecializedSignature(
    const SpecializationKey& key) {
  CurrentScope::Scope generic_scope(key.generic->ParentScope());
  // Create a temporary fake-namespace just to temporarily declare the
  // specialization aliases for the generic types to create a signature.
  Namespace tmp_namespace("_tmp");
  CurrentScope::Scope tmp_namespace_scope(&tmp_namespace);
  DeclareSpecializedTypes(key);
  return TypeVisitor::MakeSignature(
      key.generic->declaration()->callable->signature.get());
}

Callable* DeclarationVisitor::SpecializeImplicit(const SpecializationKey& key) {
  if (!key.generic->declaration()->body &&
      IntrinsicDeclaration::DynamicCast(key.generic->declaration()->callable) ==
          nullptr) {
    ReportError("missing specialization of ", key.generic->name(),
                " with types <", key.specialized_types, "> declared at ",
                key.generic->Position());
  }
  CurrentScope::Scope generic_scope(key.generic->ParentScope());
  Callable* result =
      Specialize(key, key.generic->declaration()->callable, base::nullopt,
                 key.generic->declaration()->body);
  CurrentScope::Scope callable_scope(result);
  DeclareSpecializedTypes(key);
  return result;
}

Callable* DeclarationVisitor::Specialize(
    const SpecializationKey& key, CallableNode* declaration,
    base::Optional<const CallableNodeSignature*> signature,
    base::Optional<Statement*> body) {
  // TODO(tebbi): The error should point to the source position where the
  // instantiation was requested.
  CurrentSourcePosition::Scope pos_scope(key.generic->declaration()->pos);
  size_t generic_parameter_count =
      key.generic->declaration()->generic_parameters.size();
  if (generic_parameter_count != key.specialized_types.size()) {
    std::stringstream stream;
    stream << "number of template parameters ("
           << std::to_string(key.specialized_types.size())
           << ") to intantiation of generic " << declaration->name
           << " doesnt match the generic's declaration ("
           << std::to_string(generic_parameter_count) << ")";
    ReportError(stream.str());
  }
  if (key.generic->GetSpecialization(key.specialized_types)) {
    ReportError("cannot redeclare specialization of ", key.generic->name(),
                " with types <", key.specialized_types, ">");
  }

  Signature type_signature = signature ? TypeVisitor::MakeSignature(*signature)
                                       : MakeSpecializedSignature(key);

  std::string generated_name = Declarations::GetGeneratedCallableName(
      declaration->name, key.specialized_types);
  std::stringstream readable_name;
  readable_name << declaration->name << "<";
  bool first = true;
  for (const Type* t : key.specialized_types) {
    if (!first) readable_name << ", ";
    readable_name << *t;
    first = false;
  }
  readable_name << ">";
  Callable* callable;
  if (MacroDeclaration::DynamicCast(declaration) != nullptr) {
    callable = Declarations::CreateMacro(
        generated_name, readable_name.str(), base::nullopt, type_signature,
        declaration->transitioning, *body, true);
  } else if (IntrinsicDeclaration::DynamicCast(declaration) != nullptr) {
    callable = Declarations::CreateIntrinsic(declaration->name, type_signature);
  } else {
    BuiltinDeclaration* builtin = BuiltinDeclaration::cast(declaration);
    callable = CreateBuiltin(builtin, generated_name, readable_name.str(),
                             type_signature, *body);
  }
  key.generic->AddSpecialization(key.specialized_types, callable);
  return callable;
}

void TypeDeclarationVisitor::ResolvePredeclarations() {
  for (auto& p : GlobalContext::AllDeclarables()) {
    if (const TypeAlias* alias = TypeAlias::DynamicCast(p.get())) {
      CurrentScope::Scope scope_activator(alias->ParentScope());
      CurrentSourcePosition::Scope position_activator(alias->Position());
      alias->Resolve();
    }
  }
}

}  // namespace torque
}  // namespace internal
}  // namespace v8
