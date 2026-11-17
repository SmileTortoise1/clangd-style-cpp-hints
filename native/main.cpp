#include "clang/AST/ASTConsumer.h"
#include "clang/AST/DeclCXX.h"
#include "clang/AST/ExprCXX.h"
#include "clang/AST/RecursiveASTVisitor.h"
#include "clang/AST/TypeLoc.h"
#include "clang/Frontend/FrontendAction.h"
#include "clang/Lex/Lexer.h"
#include "clang/Tooling/CompilationDatabase.h"
#include "clang/Tooling/Tooling.h"
#include "llvm/ADT/DenseMap.h"
#include "llvm/ADT/SmallString.h"
#include "llvm/Support/JSON.h"
#include "llvm/Support/MemoryBuffer.h"
#include "llvm/Support/raw_ostream.h"
#include <optional>
#include <set>

namespace {
using namespace clang;
namespace json = llvm::json;

class CommandDatabase : public tooling::CompilationDatabase {
  tooling::CompileCommand Command;
public:
  explicit CommandDatabase(tooling::CompileCommand Command)
      : Command(std::move(Command)) {}
  std::vector<tooling::CompileCommand> getCompileCommands(llvm::StringRef) const override {
    return {Command};
  }
};

class Extractor : public RecursiveASTVisitor<Extractor> {
  ASTContext &Context;
  SourceManager &Sources;
  json::Array &Hints;
  llvm::DenseMap<const EnumConstantDecl *, bool> Hexadecimal;

  std::optional<unsigned> offset(SourceLocation Loc) const {
    if (Loc.isInvalid() || Loc.isMacroID() || !Sources.isWrittenInMainFile(Loc))
      return std::nullopt;
    return Sources.getFileOffset(Loc);
  }

  SourceLocation after(SourceLocation Loc) const {
    return Lexer::getLocForEndOfToken(Loc, 0, Sources, Context.getLangOpts());
  }

  void add(SourceLocation Loc, llvm::StringRef Kind, std::string Label) {
    if (auto Offset = offset(Loc))
      Hints.emplace_back(json::Object{{"offset", *Offset}, {"kind", Kind}, {"label", std::move(Label)}});
  }

  bool containsHexadecimal(const Stmt *Expr) const {
    if (!Expr)
      return false;
    if (const auto *Literal = dyn_cast<IntegerLiteral>(Expr)) {
      auto Loc = Sources.getSpellingLoc(Literal->getLocation());
      if (Loc.isValid()) {
        llvm::SmallString<32> Buffer;
        auto Spelling = Lexer::getSpelling(Loc, Buffer, Sources, Context.getLangOpts());
        if (Spelling.starts_with_insensitive("0x"))
          return true;
      }
    }
    for (const Stmt *Child : Expr->children())
      if (containsHexadecimal(Child))
        return true;
    return false;
  }

  bool hexadecimal(const EnumConstantDecl *Member) {
    if (auto Found = Hexadecimal.find(Member); Found != Hexadecimal.end())
      return Found->second;
    bool Hex = false;
    const auto *Parent = cast<EnumDecl>(Member->getDeclContext());
    for (const EnumConstantDecl *Item : Parent->enumerators()) {
      if (Item->getInitExpr())
        Hex = containsHexadecimal(Item->getInitExpr());
      Hexadecimal.try_emplace(Item, Hex);
    }
    return Hexadecimal.lookup(Member);
  }

  void addEnum(SourceLocation Loc, const EnumConstantDecl *Member, bool Declaration) {
    if (Member->isInvalidDecl() || (Member->getInitExpr() && Member->getInitExpr()->isValueDependent()))
      return;
    auto Offset = offset(Loc);
    auto End = offset(after(Loc));
    if (!Offset || !End || *End <= *Offset)
      return;
    llvm::SmallString<32> Value;
    Member->getInitVal().toString(Value, 10);
    Hints.emplace_back(json::Object{{"offset", *Offset}, {"end", *End}, {"kind", "enum"},
        {"label", Value.str().str()}, {"declaration", Declaration}, {"hexadecimal", hexadecimal(Member)}});
  }

public:
  Extractor(ASTContext &Context, json::Array &Hints)
      : Context(Context), Sources(Context.getSourceManager()), Hints(Hints) {}

  bool TraverseDecl(Decl *Declaration) {
    if (Declaration && Declaration->getLocation().isValid() &&
        !Sources.isWrittenInMainFile(Sources.getExpansionLoc(Declaration->getLocation())))
      return true;
    return RecursiveASTVisitor<Extractor>::TraverseDecl(Declaration);
  }

  bool VisitEnumConstantDecl(EnumConstantDecl *Member) {
    addEnum(Member->getLocation(), Member, true);
    return true;
  }

  bool VisitDeclRefExpr(DeclRefExpr *Reference) {
    if (auto *Member = dyn_cast<EnumConstantDecl>(Reference->getDecl()))
      addEnum(Reference->getLocation(), Member, false);
    return true;
  }

  bool VisitCallExpr(CallExpr *Call) {
    const FunctionDecl *Function = Call->getDirectCallee();
    if (!Function || isa<CXXOperatorCallExpr>(Call) || !offset(Call->getExprLoc()))
      return true;
    for (unsigned I = 0; I < Call->getNumArgs() && I < Function->getNumParams(); ++I) {
      const Expr *Arg = Call->getArg(I);
      if (isa<CXXDefaultArgExpr>(Arg))
        continue;
      auto Offset = offset(Arg->getBeginLoc());
      auto End = offset(after(Arg->getEndLoc()));
      if (!Offset || !End)
        continue;
      const ParmVarDecl *Parameter = Function->getParamDecl(I);
      std::string Name = Parameter->getNameAsString();
      if (Name.empty())
        if (const FunctionDecl *Definition = Function->getDefinition())
          if (I < Definition->getNumParams())
            Name = Definition->getParamDecl(I)->getNameAsString();
      Hints.emplace_back(json::Object{{"offset", *Offset}, {"end", *End},
          {"kind", "parameter"}, {"name", std::move(Name)},
          {"type", Parameter->getOriginalType().getAsString(Context.getPrintingPolicy())}});
    }
    return true;
  }

  bool VisitVarDecl(VarDecl *Var) {
    if (!offset(Var->getLocation()) || Var->isImplicit() || isa<ParmVarDecl, DecompositionDecl>(Var))
      return true;
    const AutoType *Auto = Var->getType()->getContainedAutoType();
    if (Auto && Auto->isDeduced() && !Var->getType()->isDependentType())
      add(after(Var->getLocation()), "deduced", ": " + Var->getType().getAsString(Context.getPrintingPolicy()));
    return true;
  }

  bool VisitFunctionDecl(FunctionDecl *Function) {
    if (!offset(Function->getLocation()) || !Function->doesThisDeclarationHaveABody() ||
        !Function->getTypeSourceInfo())
      return true;
    auto TypeLoc = Function->getTypeSourceInfo()->getTypeLoc().getAs<FunctionTypeLoc>();
    if (TypeLoc.isNull())
      return true;
    if (const auto *Proto = Function->getType()->getAs<FunctionProtoType>())
      if (Proto->hasTrailingReturn())
        return true;
    QualType Return = Function->getReturnType();
    const AutoType *Auto = Return->getContainedAutoType();
    if (Auto && Auto->isDeduced() && !Return->isDependentType())
      add(after(TypeLoc.getRParenLoc()), "deduced", "-> " + Return.getAsString(Context.getPrintingPolicy()));
    return true;
  }

  bool VisitInitListExpr(InitListExpr *List) {
    if (!List->isSemanticForm())
      List = List->getSemanticForm();
    if (!List || !offset(List->getLBraceLoc()))
      return true;
    const bool Array = List->getType()->isArrayType();
    const RecordDecl *Record = List->getType()->getAsRecordDecl();
    if (!Array && !Record)
      return true;
    std::set<unsigned> Designated;
    if (auto *Syntax = List->getSyntacticForm())
      for (const Expr *Item : Syntax->inits())
        if (const auto *Explicit = dyn_cast_or_null<DesignatedInitExpr>(Item))
          if (auto Offset = offset(Explicit->getInit()->getBeginLoc()))
            Designated.insert(*Offset);
    std::vector<const FieldDecl *> Fields;
    if (Record) {
      if (Record->isUnion()) {
        if (const auto *Field = List->getInitializedFieldInUnion())
          Fields.push_back(Field);
      } else {
        if (const auto *Class = dyn_cast<CXXRecordDecl>(Record))
          Fields.resize(Class->getNumBases(), nullptr);
        for (const FieldDecl *Field : Record->fields())
          if (!Field->isUnnamedBitField())
            Fields.push_back(Field);
      }
    }
    for (unsigned I = 0; I < List->getNumInits(); ++I) {
      const Expr *Expr = List->getInit(I);
      if (!Expr || isa<ImplicitValueInitExpr, NoInitExpr, CXXDefaultInitExpr>(Expr))
        continue;
      auto Offset = offset(Expr->getBeginLoc());
      if (!Offset || Designated.count(*Offset))
        continue;
      if (Array)
        add(Expr->getBeginLoc(), "index", "[" + std::to_string(I) + "]=");
      else if (I < Fields.size() && Fields[I] && !Fields[I]->getName().empty())
        add(Expr->getBeginLoc(), "field", "." + Fields[I]->getNameAsString() + "=");
    }
    return true;
  }
};

class Consumer : public ASTConsumer {
  json::Array &Hints;
public:
  explicit Consumer(json::Array &Hints) : Hints(Hints) {}
  void HandleTranslationUnit(ASTContext &Context) override {
    Extractor(Context, Hints).TraverseDecl(Context.getTranslationUnitDecl());
  }
};

class Action : public ASTFrontendAction {
  json::Array &Hints;
public:
  explicit Action(json::Array &Hints) : Hints(Hints) {}
  std::unique_ptr<ASTConsumer> CreateASTConsumer(CompilerInstance &, llvm::StringRef) override {
    return std::make_unique<Consumer>(Hints);
  }
};

class Factory : public tooling::FrontendActionFactory {
  json::Array &Hints;
public:
  explicit Factory(json::Array &Hints) : Hints(Hints) {}
  std::unique_ptr<FrontendAction> create() override { return std::make_unique<Action>(Hints); }
};
} // namespace

int main() {
  auto Buffer = llvm::MemoryBuffer::getSTDIN();
  if (!Buffer)
    return 1;
  auto Parsed = json::parse((*Buffer)->getBuffer());
  if (!Parsed) {
    llvm::consumeError(Parsed.takeError());
    return 1;
  }
  const auto *Input = Parsed->getAsObject();
  if (!Input)
    return 1;
  auto File = Input->getString("file");
  auto Directory = Input->getString("directory");
  auto Text = Input->getString("text");
  const auto *Args = Input->getArray("args");
  if (!File || !Directory || !Text || !Args || Args->empty())
    return 1;
  std::vector<std::string> Command;
  for (const auto &Arg : *Args) {
    auto Value = Arg.getAsString();
    if (!Value)
      return 1;
    Command.emplace_back(Value->str());
  }
  CommandDatabase Database(tooling::CompileCommand(Directory->str(), File->str(), std::move(Command), ""));
  tooling::ClangTool Tool(Database, {File->str()});
  Tool.mapVirtualFile(*File, *Text);
  if (const auto *Files = Input->getObject("unsaved"))
    for (const auto &File : *Files)
      if (auto Contents = File.second.getAsString())
        Tool.mapVirtualFile(File.first, *Contents);
  json::Array Hints;
  Factory Frontend(Hints);
  if (Tool.run(&Frontend))
    return 2;
  llvm::outs() << json::Value(std::move(Hints)) << '\n';
}
